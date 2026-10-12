import {
  type CapabilityName,
  type Precondition,
  type PreconditionRule,
  preconditionRefusal,
} from "@stowage/core";

import type { HeaderField } from "./sign.ts";
import { azureBlobError } from "./storage-error.ts";

/** `onlyIf: { etag }`, on a write or on a `delete`, the one form spec 4.3 gives a `delete`. */
export type EtagPrecondition = Exclude<Precondition, "absent">;

/**
 * Spec 4.3: an `onlyIf` the storage declares no capability for, or of no form it takes, is
 * refused before anything is sent or signed, against the key that carries it.
 */
function refusePrecondition(
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
): Precondition | undefined {
  refusePrecondition(bucket, onlyIf, "write", operation, key, capabilities);

  if (typeof onlyIf === "object" && onlyIf !== null) return etagPreconditionOf(onlyIf);

  return onlyIf === "absent" ? onlyIf : undefined;
}

/** Spec 4.3: the `onlyIf` of a `delete` refused or read, before anything is sent. */
export function readDeletePrecondition(
  bucket: string,
  onlyIf: unknown,
  key: string,
  capabilities: readonly CapabilityName[],
): EtagPrecondition | undefined {
  refusePrecondition(bucket, onlyIf, "delete", "delete", key, capabilities);

  return typeof onlyIf === "object" && onlyIf !== null ? etagPreconditionOf(onlyIf) : undefined;
}

/** A copy of what `preconditionRefusal` checked, which the caller's object changed later leaves. */
function etagPreconditionOf(onlyIf: object): EtagPrecondition {
  return { etag: String(Reflect.get(onlyIf, "etag")) };
}

/**
 * Spec 8.4: `"absent"` travels as `If-None-Match: *`, `{ etag }` as `If-Match` with the `etag`
 * quoted as a strong tag, on the requests that write or delete the blob, and on no
 * `Put Block`, which Azure checks no precondition on.
 */
export function preconditionHeaders(onlyIf: Precondition | undefined): HeaderField[] {
  if (onlyIf === undefined) return [];
  if (onlyIf === "absent") return [["if-none-match", "*"]];

  return [["if-match", `"${onlyIf.etag}"`]];
}

/**
 * Spec 8.5: a request carrying a precondition reads its refusal after an attempt without a
 * response or with a `5xx` as that attempt's failure (ADR 0073).
 */
export function preconditionRule(onlyIf: Precondition | undefined): PreconditionRule | undefined {
  return onlyIf === undefined ? undefined : {};
}
