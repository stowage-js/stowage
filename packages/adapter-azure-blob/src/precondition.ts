import { type CapabilityName, type PreconditionRule, preconditionRefusal } from "@stowage/core";

import type { HeaderField } from "./sign.ts";
import { azureBlobError } from "./storage-error.ts";

/** The `onlyIf` of a write the storage declares a capability for. */
export type WritePrecondition = "absent";

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

  throw azureBlobError(bucket, { ...refusal, operation, key, attempts: 0 });
}

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

/**
 * Spec 8.4: `"absent"` travels as `If-None-Match: *` on the requests that write the blob, and
 * on no `Put Block`, which Azure checks no precondition on.
 */
export function preconditionHeaders(onlyIf: WritePrecondition | undefined): HeaderField[] {
  return onlyIf === undefined ? [] : [["if-none-match", "*"]];
}

/**
 * Spec 8.5: a request carrying a precondition reads its refusal after an attempt without a
 * response or with a `5xx` as that attempt's failure (ADR 0073).
 */
export function preconditionRule(
  onlyIf: WritePrecondition | undefined,
): PreconditionRule | undefined {
  return onlyIf === undefined ? undefined : {};
}
