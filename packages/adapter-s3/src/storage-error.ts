import { isStorageError, StorageError, type StorageErrorFields } from "@stowage/core";

export function s3Error(
  bucket: string,
  fields: Omit<StorageErrorFields, "bucket" | "provider">,
): StorageError {
  return new StorageError({ ...fields, bucket, provider: "s3" });
}

/**
 * The same failure told against the storage it happened in. A credential resolver is
 * written outside the adapter and knows neither bucket nor operation, so the error it
 * throws arrives without them and is re-issued here rather than reaching a caller with
 * the placeholders it was built from (spec 4.10).
 */
export function inStorage(
  failure: unknown,
  bucket: string,
  operation: string,
  key?: string,
): unknown {
  if (!isStorageError(failure)) return failure;

  return s3Error(bucket, {
    code: failure.code,
    message: failure.message,
    operation,
    key: key ?? failure.key,
    attempts: failure.attempts,
    status: failure.status,
    providerCode: failure.providerCode,
    requestId: failure.requestId,
    retryable: failure.retryable,
    capability: failure.capability,
    cause: failure.cause,
  });
}
