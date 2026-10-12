import { type CapabilityName, preconditionRefusal } from "@stowage/core";

import type { HeaderField } from "./canonical.ts";
import { s3Error } from "./storage-error.ts";

/**
 * Spec 4.3: an `onlyIf` the storage declares no capability for, `{ etag }` on a write and every
 * one on a `delete`, is refused before anything is sent or signed, against the key that
 * carries it.
 */
export function refusePrecondition(
  bucket: string,
  onlyIf: unknown,
  on: "write" | "delete",
  operation: string,
  key: string,
  capabilities: readonly CapabilityName[],
): void {
  const refusal = preconditionRefusal(onlyIf, on, capabilities);

  if (refusal === undefined) return;

  throw s3Error(bucket, { ...refusal, operation, key, attempts: 0 });
}

/** Spec 7.4: `"absent"` travels as `If-None-Match: *`, signed as every header is. */
export function preconditionHeaders(onlyIfAbsent: boolean): HeaderField[] {
  return onlyIfAbsent ? [["if-none-match", "*"]] : [];
}

/**
 * Spec 7.8: the precondition of a copy's destination, sent twice. R2 ignores `If-None-Match`
 * there and holds `cf-copy-destination-if-none-match`, which AWS ignores in turn (ADR 0071).
 */
export function copyPreconditionHeaders(onlyIfAbsent: boolean): HeaderField[] {
  return onlyIfAbsent
    ? [...preconditionHeaders(onlyIfAbsent), ["cf-copy-destination-if-none-match", "*"]]
    : [];
}
