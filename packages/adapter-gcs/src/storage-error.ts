import { isStorageError, StorageError, type StorageErrorFields } from "@stowage/core";

export function gcsError(
  bucket: string,
  fields: Omit<StorageErrorFields, "bucket" | "provider">,
): StorageError {
  return new StorageError({ ...fields, bucket, provider: "gcs" });
}

/**
 * A `NotFound` of the key. A missing bucket is the one `NotFound` that names no key, and
 * says nothing about the object.
 */
export function isMissingObject(failure: unknown): boolean {
  return isStorageError(failure) && failure.code === "NotFound" && failure.key !== undefined;
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

  return gcsError(bucket, { ...fieldsOf(failure), operation, key: key ?? failure.key });
}

/** The same failure counting `attempts`, for a loop that reports an attempt before the last. */
export function countingAttempts(failure: StorageError, attempts: number): StorageError {
  return gcsError(failure.bucket, { ...fieldsOf(failure), attempts });
}

/**
 * The same failure with every one of `secrets` cut out of its message and without its cause,
 * which the runtime wrote and which may carry a secret in a form no search here would find.
 */
export function withoutSecrets(
  failure: StorageError,
  secrets: readonly string[],
  placeholder: string,
): StorageError {
  let message = failure.message;

  for (const secret of secrets) message = message.replaceAll(secret, placeholder);

  return gcsError(failure.bucket, { ...fieldsOf(failure), message, cause: undefined });
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
