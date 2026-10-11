import {
  type CapabilityName,
  type Precondition,
  preconditionRefusal,
  type StorageError,
} from "@stowage/core";

import { memoryError } from "./storage-error.ts";

/**
 * The precondition as it is held, read once out of what the call carried. Rejects before
 * anything is read or written, in the order of spec 4.3, against the key that carries it.
 */
export function readPrecondition(
  onlyIf: unknown,
  operation: string,
  key: string,
  capabilities: readonly CapabilityName[],
): Precondition | undefined {
  const refusal = preconditionRefusal(onlyIf, "write", capabilities);

  if (refusal !== undefined) throw memoryError({ ...refusal, operation, key, attempts: 0 });

  if (typeof onlyIf === "object" && onlyIf !== null) {
    return { etag: String(Reflect.get(onlyIf, "etag")) };
  }

  return onlyIf === "absent" ? "absent" : undefined;
}

/** The failure of a precondition the object under `key`, or its absence, does not meet. */
export function preconditionFailure(
  precondition: Precondition | undefined,
  held: { readonly etag: string } | undefined,
  operation: string,
  key: string,
): StorageError | undefined {
  if (precondition === undefined) return undefined;

  if (precondition === "absent") {
    if (held === undefined) return undefined;

    return failed(`The key ${JSON.stringify(key)} holds an object`, operation, key);
  }

  if (held?.etag === precondition.etag) return undefined;

  return failed(
    `The key ${JSON.stringify(key)} holds no object the \`etag\` describes`,
    operation,
    key,
  );
}

function failed(message: string, operation: string, key: string): StorageError {
  return memoryError({ code: "PreconditionFailed", message, operation, key, attempts: 1 });
}
