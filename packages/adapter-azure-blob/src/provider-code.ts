import {
  errorCodeForStatus,
  isTransientStatus,
  type StorageError,
  type StorageErrorCode,
} from "@stowage/core";

import { segmentLimit } from "./key.ts";
import { azureBlobError } from "./storage-error.ts";

/**
 * The table of spec 8.8: a code recognized here decides the error code alone, and an
 * unrecognized one falls to the status mapping of spec 4.10. Whether the condition is
 * transient is never read from here — ADR 0013 decides that by the status, so that an
 * unknown `5xx` is treated no worse than one stowage has heard of.
 */
const providerCodes: ReadonlyMap<string, StorageErrorCode> = new Map([
  ["BlobNotFound", "NotFound"],
  ["ContainerNotFound", "NotFound"],
  ["ResourceNotFound", "NotFound"],
  ["AuthorizationPermissionMismatch", "AccessDenied"],
  ["InsufficientAccountPermissions", "AccessDenied"],
  ["AccountIsDisabled", "AccessDenied"],
  ["UnauthorizedBlobOverwrite", "AccessDenied"],
  ["InvalidAuthenticationInfo", "InvalidCredentials"],
  ["NoAuthenticationInformation", "InvalidCredentials"],
  // A clock more than 15 minutes off arrives as this code too, which Azure does not tell
  // apart from a wrong key (ADR 0021).
  ["AuthenticationFailed", "InvalidCredentials"],
  ["KeyBasedAuthenticationNotPermitted", "InvalidCredentials"],
  ["InvalidRange", "InvalidRequest"],
  ["RequestBodyTooLarge", "InvalidRequest"],
  ["BlockCountExceedsLimit", "InvalidRequest"],
  // Reached only for metadata the core accepted.
  ["MetadataTooLarge", "InvalidRequest"],
  ["InvalidMetadata", "InvalidRequest"],
  // On a block upload, usually another writer won (spec 8.6).
  ["InvalidBlockList", "ProviderError"],
  ["InvalidBlobOrBlock", "ProviderError"],
  // States of the blob stowage does not create.
  ["PendingCopyOperation", "ProviderError"],
  ["BlobArchived", "ProviderError"],
  ["SnapshotsPresent", "ProviderError"],
  ["LeaseIdMissing", "ProviderError"],
  ["BlobImmutableDueToPolicy", "ProviderError"],
  // Transient by status.
  ["ServerBusy", "ProviderError"],
  ["InternalError", "ProviderError"],
  ["OperationTimedOut", "ProviderError"],
]);

const badRequest = 400;
const unauthorized = 401;
const conflict = 409;

/**
 * The longest blob name Azure holds, in characters. `length` counts UTF-16 code units, as
 * .NET measures a string, which is never fewer than the code points: a key above the
 * limit in either count is above it in this one.
 */
const longestHeldKey = 1024;

/** What the provider answered a request with, as much of it as spec 8.8 reads. */
export interface ProviderAnswer {
  readonly status: number;
  /** The method, which says what a provider that sent no message answered to. */
  readonly method: string;
  /** The key the request addressed, whose length tells what a bare `400` means. */
  readonly key?: string;
  readonly providerCode?: string;
  readonly providerMessage?: string;
  /** Whether the request went out under an access token the resolver had just refreshed. */
  readonly underRefreshedToken: boolean;
  /** Whether the request was a `Put Blob From URL`, whose unnamed `409` spec 8.7 reads. */
  readonly copiesFromUrl: boolean;
  /** What the source of a copy answered the service, from `x-ms-copy-source-status-code`. */
  readonly copySourceStatus?: number;
}

export interface ProviderFailure {
  readonly code: StorageErrorCode;
  readonly message: string;
}

/**
 * What the provider's answer means, decided by its own code where the table recognizes
 * one and by the status where it does not. The message is the provider's word for word
 * (spec 4.10), except where spec 8.3 has it say what the caller can act on: a credential
 * the account does not take, and a token that a refresh did not make acceptable.
 */
export function readProviderFailure(answer: ProviderAnswer): ProviderFailure {
  // Spec 4.10: where the provider sent no message, the status and the code are the whole
  // of what there is to say — a `HEAD` carries no body to read one out of.
  const said = answer.providerMessage ?? statusMessage(answer);

  if (answer.providerCode === "KeyBasedAuthenticationNotPermitted") {
    return {
      code: "InvalidCredentials",
      message: `The account takes no \`accountKey\`, and an \`accessToken\` is the credential it accepts: ${said}`,
    };
  }

  // ADR 0021: an expired token and a forged one answer alike, so the message names both
  // and leaves the caller, who knows what the resolver handed over, to tell them apart.
  if (answer.underRefreshedToken && isRefusedToken(answer)) {
    return {
      code: "InvalidCredentials",
      message: `The access token expired or is not accepted, and so is the one the resolver refreshed: ${said}`,
    };
  }

  // ADR 0025: the service answers a failure on the source under its own code, and the
  // source's status says which failure it was.
  if (answer.providerCode === "CannotVerifyCopySource") {
    const status = answer.copySourceStatus ?? answer.status;

    return { code: errorCodeForStatus(status) ?? "ProviderError", message: said };
  }

  const recognized =
    answer.providerCode === undefined ? undefined : providerCodes.get(answer.providerCode);

  if (recognized !== undefined) return { code: recognized, message: said };

  // Spec 8.7: the service names no code for a source above what one `Put Blob From URL`
  // copies, and a fallback to blocks copied by range is declined (ADR 0025).
  if (answer.copiesFromUrl && answer.status === conflict) {
    return {
      code: "InvalidRequest",
      message: `The source is above the 5,000 MiB one copy takes, or reported no valid length: ${said}`,
    };
  }

  // Spec 8.8: an addressable key the provider cannot hold, which spec 8.1 lets through so
  // that a blob another tool wrote stays reachable, and which Azure names by no code.
  const beyond = answer.key === undefined ? undefined : beyondHeldKey(answer.key);

  if (answer.status === badRequest && beyond !== undefined) {
    return { code: "InvalidKey", message: `The key ${beyond} the provider holds: ${said}` };
  }

  return { code: errorCodeForStatus(answer.status) ?? "ProviderError", message: said };
}

/** A failed response, as much of it as spec 8.8 reads, and the request it answered. */
export interface FailedResponse {
  readonly operation: string;
  readonly method: string;
  readonly key?: string;
  /** The key a `Put Blob From URL` copies from. */
  readonly copySource?: string;
  readonly status: number;
  readonly headers: Headers;
  readonly providerMessage?: string;
  readonly attempts: number;
  readonly underRefreshedToken: boolean;
}

/**
 * Spec 8.8: the provider's code decides where the table recognizes one, the status of
 * spec 4.10 decides where it does not, and the status alone decides whether the condition
 * is transient. Azure names its code in `x-ms-error-code` on every failure, a `HEAD` and
 * a subresponse of a Blob Batch included.
 */
export function providerError(container: string, response: FailedResponse): StorageError {
  const providerCode = response.headers.get("x-ms-error-code") ?? undefined;
  const failure = readProviderFailure({
    status: response.status,
    method: response.method,
    key: response.key,
    providerCode,
    providerMessage: response.providerMessage,
    underRefreshedToken: response.underRefreshedToken,
    copiesFromUrl: response.copySource !== undefined,
    copySourceStatus: statusOf(response.headers.get("x-ms-copy-source-status-code")),
  });
  const failedOnSource = providerCode === "CannotVerifyCopySource";

  return azureBlobError(container, {
    code: failure.code,
    message: failure.message,
    operation: response.operation,
    key: failedOnSource ? (response.copySource ?? response.key) : response.key,
    attempts: response.attempts,
    status: response.status,
    providerCode,
    requestId: response.headers.get("x-ms-request-id") ?? undefined,
    retryable: isTransientStatus(response.status),
  });
}

function statusOf(header: string | null): number | undefined {
  const status = Number(header ?? "");

  return Number.isInteger(status) && status >= 100 && status <= 599 ? status : undefined;
}

function beyondHeldKey(key: string): string | undefined {
  if (key.length > longestHeldKey) {
    return `is longer than the ${longestHeldKey} characters`;
  }

  if (key.split("/").length > segmentLimit) return `has more than the ${segmentLimit} segments`;

  return undefined;
}

function statusMessage(answer: ProviderAnswer): string {
  const code = answer.providerCode === undefined ? "" : ` ${answer.providerCode}`;

  return `The provider answered ${answer.status}${code} to \`${answer.method}\``;
}

/**
 * Spec 8.3: the one answer an expired access token hides behind, after which the adapter
 * resolves the credential once more with `forceRefresh: true`.
 */
export function isRefusedToken(answer: Pick<ProviderAnswer, "status" | "providerCode">): boolean {
  return answer.status === unauthorized && answer.providerCode === "InvalidAuthenticationInfo";
}
