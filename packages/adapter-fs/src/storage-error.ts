import { StorageError, type StorageErrorFields } from "@stowage/core";

/** What a failure carries beyond the two fields the storage itself fixes. */
export type FsErrorFields = Omit<StorageErrorFields, "bucket" | "provider">;

/** `bucket` is the root as the storage was given it, which spec 6 names as the bucket. */
export function fsError(root: string, fields: FsErrorFields): StorageError {
  return new StorageError({ ...fields, bucket: root, provider: "fs" });
}
