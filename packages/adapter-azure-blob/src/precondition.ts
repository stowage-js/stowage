import { type CapabilityName, preconditionRefusal } from "@stowage/core";

import { azureBlobError } from "./storage-error.ts";

/**
 * Spec 4.3: the storage declares neither `writeIfAbsent` nor `writeIfUnchanged`, so every
 * `onlyIf` is refused before anything is sent or signed, against the key that carries it.
 */
export function refusePrecondition(
  bucket: string,
  onlyIf: unknown,
  operation: string,
  key: string,
  capabilities: readonly CapabilityName[],
): void {
  const refusal = preconditionRefusal(onlyIf, "write", capabilities);

  if (refusal === undefined) return;

  throw azureBlobError(bucket, { ...refusal, operation, key, attempts: 0 });
}
