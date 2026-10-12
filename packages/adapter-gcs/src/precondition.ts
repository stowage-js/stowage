import { type CapabilityName, type PreconditionRule, preconditionRefusal } from "@stowage/core";

import type { HeaderField, QueryParameter } from "./request.ts";
import { gcsError } from "./storage-error.ts";

/** The `onlyIf` of a write the storage declares a capability for. */
export type WritePrecondition = "absent";

/** The generation `ifGenerationMatch` names for a key that holds no object (spec 9.4). */
const noGeneration = "0";

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

  throw gcsError(bucket, { ...refusal, operation, key, attempts: 0 });
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
 * Spec 9.4: `"absent"` travels as `ifGenerationMatch=0` on the insert, the start of a
 * resumable session, every call of `rewriteTo` and `objects.move`.
 */
export function preconditionQuery(onlyIf: WritePrecondition | undefined): QueryParameter[] {
  return onlyIf === undefined ? [] : [["ifGenerationMatch", noGeneration]];
}

/** Spec 9.9: the same precondition as the signed header the XML API reads (ADR 0074). */
export function preconditionHeaders(onlyIf: WritePrecondition | undefined): HeaderField[] {
  return onlyIf === undefined ? [] : [["x-goog-if-generation-match", noGeneration]];
}

/**
 * Spec 9.5: a request carrying a precondition reads its refusal after an attempt without a
 * response or with a `5xx` as that attempt's failure (ADR 0073). The requests of a resumable
 * session take no part in it.
 */
export function preconditionRule(
  onlyIf: WritePrecondition | undefined,
): PreconditionRule | undefined {
  return onlyIf === undefined ? undefined : {};
}
