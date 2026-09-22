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
  // R2's; provisional until the scheduled run of spec section 12 settles it.
  ["ExpiredRequest", "Expired"],
  // A clock that has drifted is the caller's own bug and arrives at `403`, which is what
  // keeps it out of the retry group without a rule of its own (ADR 0013).
  ["RequestTimeTooSkewed", "InvalidRequest"],
  ["InvalidRange", "InvalidRequest"],
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

/** The option a refused request names, where spec 7.9 has it name one (spec 4.3). */
export type RefusedOption = "cursor" | "region";

export interface ProviderFailure {
  readonly code: StorageErrorCode;
  readonly option?: RefusedOption;
}

// Spec 7.1: the bucket lives in another region than the one the request was signed for.
const permanentRedirect = 301;

/**
 * What the provider's answer means, from its own code where the table recognizes one and
 * from the status where it does not.
 */
export function readProviderFailure(
  providerCode: string | undefined,
  status: number,
  operation: string,
): ProviderFailure {
  // Spec 7.1 reads a `301` as a `region` the caller configured wrong, and a `HEAD` that
  // meets one carries no body to read `PermanentRedirect` out of, so the status says it.
  if (status === permanentRedirect || providerCode === "PermanentRedirect") {
    return { code: "InvalidOption", option: "region" };
  }

  // Spec 7.9: `InvalidArgument` answered to a listing is the provider refusing the
  // continuation token, which reaches the caller as the `cursor` they handed `list`.
  if (providerCode === "InvalidArgument" && operation === "list") {
    return { code: "InvalidOption", option: "cursor" };
  }

  const recognized = providerCode === undefined ? undefined : providerCodes.get(providerCode);

  return { code: recognized ?? errorCodeForStatus(status) ?? "ProviderError" };
}
