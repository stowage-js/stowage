import {
  type CapabilityName,
  type Precondition,
  type PreconditionRule,
  preconditionRefusal,
  type StorageError,
} from "@stowage/core";

import type { HeaderField, QueryParameter } from "./request.ts";
import { gcsError } from "./storage-error.ts";

/** The `onlyIf` of a `delete`, the one form spec 4.3 gives it. */
export type DeletePrecondition = Exclude<Precondition, "absent">;

/** The generation `ifGenerationMatch` names for a key that holds no object (spec 9.4). */
const noGeneration = "0";

/** The largest generation, GCS's `int64` (ADR 0071). */
const largestGeneration = 2n ** 63n - 1n;

/** Decimal digits without a leading zero, which leaves `0` out (ADR 0071). */
const generationDigits = /^[1-9]\d*$/u;

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

  throw gcsError(bucket, { ...refusal, operation, key, attempts: 0 });
}

/**
 * Spec 4.3 and 9.1: the `onlyIf` of a write refused or read, before anything is sent or
 * signed. An `etag` that is no generation never matches, and is refused as GCS would refuse
 * it.
 */
export function readWritePrecondition(
  bucket: string,
  onlyIf: unknown,
  operation: string,
  key: string,
  capabilities: readonly CapabilityName[],
): Precondition | undefined {
  refusePrecondition(bucket, onlyIf, "write", operation, key, capabilities);

  if (typeof onlyIf === "object" && onlyIf !== null) {
    const precondition = etagOf(onlyIf);
    const refusal = noGenerationRefusal(bucket, precondition, operation, key);

    if (refusal !== undefined) throw refusal;

    return precondition;
  }

  return onlyIf === "absent" ? onlyIf : undefined;
}

/**
 * Spec 4.3: the `onlyIf` of a `delete` refused or read, before anything is sent. An `etag`
 * that is no generation is read as well, since spec 4.7 has its refusal be the key's entry
 * rather than the call's.
 */
export function readDeletePrecondition(
  bucket: string,
  onlyIf: unknown,
  key: string,
  capabilities: readonly CapabilityName[],
): DeletePrecondition | undefined {
  refusePrecondition(bucket, onlyIf, "delete", "delete", key, capabilities);

  return typeof onlyIf === "object" && onlyIf !== null ? etagOf(onlyIf) : undefined;
}

/**
 * Spec 9.1 and ADR 0071: an `etag` that is no generation never matches, so it is the
 * `PreconditionFailed` GCS would answer, without a request. `0` is no generation here,
 * since `ifGenerationMatch=0` would turn "unchanged" into "absent" in silence.
 */
export function noGenerationRefusal(
  bucket: string,
  onlyIf: DeletePrecondition,
  operation: string,
  key: string,
): StorageError | undefined {
  const { etag } = onlyIf;

  if (generationDigits.test(etag) && BigInt(etag) <= largestGeneration) return undefined;

  return gcsError(bucket, {
    code: "PreconditionFailed",
    message: "The `etag` names no generation, so no object matches it",
    operation,
    key,
    attempts: 0,
    retryable: false,
  });
}

/** A copy of what `preconditionRefusal` checked, which the caller's object changed later leaves. */
function etagOf(onlyIf: object): DeletePrecondition {
  return { etag: String(Reflect.get(onlyIf, "etag")) };
}

/** The generation `ifGenerationMatch` names: `0` for `"absent"`, the `etag` for `{ etag }`. */
function generationOf(onlyIf: Precondition): string {
  return onlyIf === "absent" ? noGeneration : onlyIf.etag;
}

/**
 * Spec 9.4: the precondition travels as `ifGenerationMatch` on the insert, the start of a
 * resumable session, every call of `rewriteTo`, `objects.move` and a conditional `DELETE`.
 */
export function preconditionQuery(onlyIf: Precondition | undefined): QueryParameter[] {
  return onlyIf === undefined ? [] : [["ifGenerationMatch", generationOf(onlyIf)]];
}

/** Spec 9.9: the same precondition as the signed header the XML API reads (ADR 0074). */
export function preconditionHeaders(onlyIf: Precondition | undefined): HeaderField[] {
  return onlyIf === undefined ? [] : [["x-goog-if-generation-match", generationOf(onlyIf)]];
}

/**
 * Spec 9.5: a request carrying a precondition reads its refusal after an attempt without a
 * response or with a `5xx` as that attempt's failure (ADR 0073). The requests of a resumable
 * session take no part in it.
 */
export function preconditionRule(onlyIf: Precondition | undefined): PreconditionRule | undefined {
  return onlyIf === undefined ? undefined : {};
}
