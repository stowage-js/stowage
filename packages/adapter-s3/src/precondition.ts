import { type CapabilityName, preconditionRefusal } from "@stowage/core";

import { s3Error } from "./storage-error.ts";

/**
 * Spec 4.3: the storage declares no capability an `onlyIf` needs, so every one is refused
 * before anything is sent or signed, against the key that carries it.
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
