import { errorCodeForStatus, type StorageErrorCode } from "@stowage/core";

/**
 * The table of spec 7.9, holding both vendors' strings: a code recognized here decides
 * the error code alone, and an unrecognized one falls to the status mapping of spec 4.10.
 * Whether the condition is transient is never read from here — ADR 0013 decides that by
 * the status, so that an unknown `5xx` is treated no worse than one stowage has heard of.
 */
const providerCodes: ReadonlyMap<string, StorageErrorCode> = new Map([
  ["NoSuchKey", "NotFound"],
  ["NoSuchBucket", "NotFound"],
  ["AccessDenied", "AccessDenied"],
  ["InvalidAccessKeyId", "InvalidCredentials"],
  ["SignatureDoesNotMatch", "InvalidCredentials"],
  // R2's, answered at `401`.
  ["Unauthorized", "InvalidCredentials"],
  ["ExpiredToken", "Expired"],
  // R2's; provisional, because no run can provoke it against R2 yet (spec 13).
  ["ExpiredRequest", "Expired"],
  // A clock that has drifted is the caller's own bug and arrives at `403`, which is what
  // keeps it out of the retry group without a rule of its own (ADR 0013).
  ["RequestTimeTooSkewed", "InvalidRequest"],
  ["InvalidRange", "InvalidRequest"],
  // AWS's, answered among others to a `CopyObject` source above 5 GiB, which R2 answers
  // with `EntityTooLarge`: one condition, one code for the caller to branch on.
  ["InvalidRequest", "InvalidRequest"],
  ["InvalidArgument", "InvalidRequest"],
  ["MetadataTooLarge", "InvalidRequest"],
  ["EntityTooLarge", "InvalidRequest"],
  ["EntityTooSmall", "InvalidRequest"],
  ["InvalidPart", "InvalidRequest"],
  ["InvalidPartOrder", "InvalidRequest"],
  ["BadDigest", "InvalidRequest"],
  ["MalformedXML", "InvalidRequest"],
  ["InvalidDigest", "InvalidRequest"],
  // Reached only for a key the core accepted, which an adapter may narrow further.
  ["InvalidObjectName", "InvalidKey"],
  ["KeyTooLongError", "InvalidKey"],
  ["NoSuchUpload", "ProviderError"],
  ["SlowDown", "ProviderError"],
  ["TooManyRequests", "ProviderError"],
  ["ServiceUnavailable", "ProviderError"],
  ["InternalError", "ProviderError"],
  ["RequestTimeout", "ProviderError"],
]);

/** What a provider answered a request with, as much of it as spec 7.9 reads. */
export interface ProviderAnswer {
  readonly status: number;
  /** The operation the caller invoked, which decides what `InvalidArgument` means. */
  readonly operation: string;
  /** The method, which says what a provider that sent no message answered to. */
  readonly method: string;
  /** The key the request addressed, whose length tells what a bare `400` to `HEAD` means. */
  readonly key?: string;
  /** Whether the request included the continuation token a `cursor` becomes. */
  readonly hasContinuationToken?: boolean;
  readonly providerCode?: string;
  readonly providerMessage?: string;
  /** `x-amz-bucket-region`, the region a redirect says the bucket is really in. */
  readonly bucketRegion?: string;
}

export interface ProviderFailure {
  readonly code: StorageErrorCode;
  readonly message: string;
}

// Spec 7.1: the bucket lives in another region than the one the request was signed for.
const permanentRedirect = 301;

const badRequest = 400;

/** The longest key AWS S3 and R2 hold, in UTF-8 bytes, above which they answer `KeyTooLongError`. */
const longestHeldKey = 1024;

const utf8 = new TextEncoder();

/**
 * What the provider's answer means, decided by its own code where the table recognizes
 * one and by the status where it does not. The message is the provider's word for word
 * (spec 4.10), except where spec 7.9 has the failure name the option that is wrong: a
 * caller can act on `region` and on `cursor`, and cannot on a message about either.
 */
export function readProviderFailure(answer: ProviderAnswer): ProviderFailure {
  // Spec 4.10: where the provider sent no message, the status is the whole of what there
  // is to say — a `HEAD` carries no body to read one out of.
  const said =
    answer.providerMessage ?? `The provider answered ${answer.status} to \`${answer.method}\``;

  // Spec 7.1 reads a `301` as a `region` the caller configured wrong, and a `HEAD` that
  // meets one carries no body to read `PermanentRedirect` out of, so the status says it.
  if (answer.status === permanentRedirect || answer.providerCode === "PermanentRedirect") {
    const region = answer.bucketRegion === undefined ? "" : `, which is \`${answer.bucketRegion}\``;

    return {
      code: "InvalidOption",
      message: `The option \`region\` is not the bucket's${region}: ${said}`,
    };
  }

  // Spec 7.9: a key above what the provider holds is `KeyTooLongError`, which a `HEAD`
  // carries no body to name, so the `400` it arrives as is read as that code.
  if (
    answer.method === "HEAD" &&
    answer.status === badRequest &&
    answer.key !== undefined &&
    utf8.encode(answer.key).byteLength > longestHeldKey
  ) {
    return {
      code: "InvalidKey",
      message: `The key is longer than the ${longestHeldKey} bytes the provider holds: ${said}`,
    };
  }

  // Spec 7.9: `InvalidArgument` answered to a continued listing is the provider refusing
  // the continuation token, which reaches the caller as the `cursor` they handed `list`.
  if (
    answer.providerCode === "InvalidArgument" &&
    answer.operation === "list" &&
    answer.hasContinuationToken
  ) {
    return {
      code: "InvalidOption",
      message: `The option \`cursor\` is not one the provider continued from: ${said}`,
    };
  }

  const recognized =
    answer.providerCode === undefined ? undefined : providerCodes.get(answer.providerCode);

  return {
    code: recognized ?? errorCodeForStatus(answer.status) ?? "ProviderError",
    message: said,
  };
}

/**
 * The codes of the table a provider answers with a transient status: the five the table
 * leaves to the status, as spec 7.9 notes beside them.
 */
const transientProviderCodes: ReadonlySet<string> = new Set([
  "SlowDown",
  "TooManyRequests",
  "ServiceUnavailable",
  "InternalError",
  "RequestTimeout",
]);

export interface EmbeddedFailure extends ProviderFailure {
  readonly retryable: boolean;
}

/**
 * A failure the provider reported inside a `200`, such as one key of a `DeleteObjects` or
 * a `CopyObject` that failed after the answer began. No status speaks for it, so the code
 * decides alone; whether it is transient is read off the code, since spec 4.7 has the
 * entry carry `retryable` for a caller who repeats it. Nothing here is repeated: ADR 0013
 * lets no provider code into the retry group.
 */
export function readEmbeddedFailure(
  providerCode: string,
  providerMessage: string,
): EmbeddedFailure {
  return {
    code: providerCodes.get(providerCode) ?? "ProviderError",
    message: providerMessage,
    retryable: transientProviderCodes.has(providerCode),
  };
}
