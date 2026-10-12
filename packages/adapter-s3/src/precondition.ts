import { type CapabilityName, type PreconditionRule, preconditionRefusal } from "@stowage/core";

import type { HeaderField } from "./canonical.ts";
import { s3Error } from "./storage-error.ts";

/**
 * Spec 4.3: an `onlyIf` the storage declares no capability for, every one on a `delete`, is
 * refused before anything is sent or signed, against the key that carries it.
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

/** The precondition a write carries, of a form `refusePrecondition` let through. */
export type WritePrecondition = "absent" | { readonly etag: string };

/** Spec 4.3: the `onlyIf` of a write refused or read, before anything is sent or signed. */
export function readWritePrecondition(
  bucket: string,
  onlyIf: unknown,
  operation: string,
  key: string,
  capabilities: readonly CapabilityName[],
): WritePrecondition | undefined {
  refusePrecondition(bucket, onlyIf, "write", operation, key, capabilities);

  if (typeof onlyIf === "object" && onlyIf !== null) {
    return { etag: String(Reflect.get(onlyIf, "etag")) };
  }

  return onlyIf === "absent" ? onlyIf : undefined;
}

/**
 * Spec 7.4: `"absent"` travels as `If-None-Match: *`, `{ etag }` as `If-Match` with the `etag`
 * quoted as a strong tag, signed as every header is.
 */
export function preconditionHeaders(onlyIf: WritePrecondition | undefined): HeaderField[] {
  if (onlyIf === undefined) return [];
  if (onlyIf === "absent") return [["if-none-match", "*"]];

  return [["if-match", `"${onlyIf.etag}"`]];
}

/**
 * Spec 7.8: the precondition of a copy's destination, sent twice. R2 ignores `If-None-Match`
 * and `If-Match` there and holds their `cf-copy-destination-` twins, which AWS ignores in
 * turn (ADR 0071).
 */
export function copyPreconditionHeaders(onlyIf: WritePrecondition | undefined): HeaderField[] {
  return preconditionHeaders(onlyIf).flatMap(([name, value]): HeaderField[] => [
    [name, value],
    [`cf-copy-destination-${name}`, value],
  ]);
}

/**
 * Spec 7.9: AWS answers `If-Match` against a key that holds no object with `404 NoSuchKey`,
 * which is the precondition's refusal. On `CopyObject` the same answer reports a missing
 * source, and only a `<Key>` naming `destination` is the refusal (ADR 0071).
 */
export function missingKeyRefusal(
  onlyIf: WritePrecondition | undefined,
  destination?: string,
): ((named: string | undefined) => boolean) | undefined {
  if (typeof onlyIf !== "object") return undefined;
  if (destination === undefined) return () => true;

  return (named) => named === destination;
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
