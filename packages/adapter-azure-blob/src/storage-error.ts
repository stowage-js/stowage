import { isStorageError, StorageError, type StorageErrorFields } from "@stowage/core";

export function azureBlobError(
  container: string,
  fields: Omit<StorageErrorFields, "bucket" | "provider">,
): StorageError {
  return new StorageError({ ...fields, bucket: container, provider: "azure-blob" });
}

/**
 * The same failure told against the storage it happened in. A credential resolver is
 * written outside the adapter and knows neither container nor operation, so the error it
 * throws arrives without them and is re-issued here rather than reaching a caller with
 * the placeholders it was built from (spec 4.10).
 */
export function inStorage(
  failure: unknown,
  container: string,
  operation: string,
  key?: string,
): unknown {
  if (!isStorageError(failure)) return failure;

  return azureBlobError(container, { ...fieldsOf(failure), operation, key: key ?? failure.key });
}

/**
 * The same failure of a step the adapter repeated itself, told with every attempt the step
 * made and as one that a later call of the whole operation may not meet.
 */
export function asRetryable(
  failure: StorageError,
  container: string,
  attempts: number,
): StorageError {
  return azureBlobError(container, { ...fieldsOf(failure), attempts, retryable: true });
}

/**
 * Every field of `StorageErrorFields` is named below, so a field added to that type has
 * to be added here too or it is dropped on the way through.
 */
function fieldsOf(failure: StorageError): Omit<StorageErrorFields, "bucket" | "provider"> {
  return {
    code: failure.code,
    message: failure.message,
    operation: failure.operation,
    key: failure.key,
    attempts: failure.attempts,
    status: failure.status,
    providerCode: failure.providerCode,
    requestId: failure.requestId,
    retryable: failure.retryable,
    capability: failure.capability,
    cause: failure.cause,
  };
}
