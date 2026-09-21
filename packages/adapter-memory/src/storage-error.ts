import { StorageError, type StorageErrorFields } from "@stowage/core";

/** What a memory storage reports as its provider and as the bucket it is bound to. */
export const memoryName = "memory";

export function memoryError(fields: Omit<StorageErrorFields, "bucket" | "provider">): StorageError {
  return new StorageError({ ...fields, bucket: memoryName, provider: memoryName });
}
