import { type CapabilityName, type PreconditionRule, preconditionRefusal } from "@stowage/core";

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

/**
 * The precondition a write carries. `"absent"` alone, since the storage does not declare
 * `writeIfUnchanged` and `refusePrecondition` refuses an `etag`.
 */
export type WritePrecondition = "absent";

/** Spec 4.3: the `onlyIf` of a write refused or read, before anything is sent or signed. */
export function readWritePrecondition(
  bucket: string,
  onlyIf: unknown,
  operation: string,
  key: string,
  capabilities: readonly CapabilityName[],
): WritePrecondition | undefined {
  refusePrecondition(bucket, onlyIf, "write", operation, key, capabilities);

  return onlyIf === "absent" ? onlyIf : undefined;
}

/** Spec 7.4: `"absent"` travels as `If-None-Match: *`, signed as every header is. */
export function preconditionHeaders(onlyIf: WritePrecondition | undefined): HeaderField[] {
  return onlyIf === "absent" ? [["if-none-match", "*"]] : [];
}

/**
 * Spec 7.8: the precondition of a copy's destination, sent twice. R2 ignores `If-None-Match`
 * there and holds `cf-copy-destination-if-none-match`, which AWS ignores in turn (ADR 0071).
 */
export function copyPreconditionHeaders(onlyIf: WritePrecondition | undefined): HeaderField[] {
  return onlyIf === "absent"
    ? [
        ["if-none-match", "*"],
        ["cf-copy-destination-if-none-match", "*"],
      ]
    : [];
}

/**
 * Spec 7.5: a request carrying a precondition reads its refusal after an attempt without a
 * response or with a `5xx` as that attempt's failure (ADR 0073).
 */
export function preconditionRule(
  onlyIf: WritePrecondition | undefined,
  alsoRefusedBy?: readonly string[],
): PreconditionRule | undefined {
  return onlyIf === undefined ? undefined : { alsoRefusedBy };
}
