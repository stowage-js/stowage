import { StorageError, type StorageErrorFields } from "@stowage/core";

export function memoryError(fields: Omit<StorageErrorFields, "bucket" | "provider">): StorageError {
  return new StorageError({ ...fields, bucket: "memory", provider: "memory" });
}
