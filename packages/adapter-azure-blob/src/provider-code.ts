import { errorCodeForStatus, type StorageErrorCode } from "@stowage/core";

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

/** What the provider answered a request with, as much of it as spec 8.8 reads. */
export interface ProviderAnswer {
  readonly status: number;
  /** The method, which says what a provider that sent no message answered to. */
  readonly method: string;
  readonly providerCode?: string;
  readonly providerMessage?: string;
}

export interface ProviderFailure {
  readonly code: StorageErrorCode;
  readonly message: string;
}

/**
 * What the provider's answer means, decided by its own code where the table recognizes
 * one and by the status where it does not. The message is the provider's word for word
 * (spec 4.10).
 */
export function readProviderFailure(answer: ProviderAnswer): ProviderFailure {
  // Spec 4.10: where the provider sent no message, the status and the code are the whole
  // of what there is to say — a `HEAD` carries no body to read one out of.
  const said = answer.providerMessage ?? statusMessage(answer);
  const recognized =
    answer.providerCode === undefined ? undefined : providerCodes.get(answer.providerCode);

  return {
    code: recognized ?? errorCodeForStatus(answer.status) ?? "ProviderError",
    message: said,
  };
}

function statusMessage(answer: ProviderAnswer): string {
  const code = answer.providerCode === undefined ? "" : ` ${answer.providerCode}`;

  return `The provider answered ${answer.status}${code} to \`${answer.method}\``;
}
