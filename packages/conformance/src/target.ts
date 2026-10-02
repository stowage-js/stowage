import type { CapabilityName, Storage } from "@stowage/core";

export interface ConformanceTarget {
  readonly name: string;
  createStorage(): Storage | Promise<Storage>;
  cleanup?(keyPrefix: string): Promise<void>;
  createStorageWithBadCredentials?(): Storage | Promise<Storage>;
  createStorageWithExpiredCredentials?(): Storage | Promise<Storage>;
  createStorageWithDeniedCredentials?(): Storage | Promise<Storage>;
  /**
   * A storage bound to a bucket, container or root that does not exist and otherwise
   * configured as the storage of `createStorage()` (spec 14.3). A target whose adapter has
   * no bucket to miss leaves it out.
   */
  createStorageWithMissingBucket?(): Storage | Promise<Storage>;
}

/** The factories of spec 14.3, each of which a target may leave out. */
export type ConformanceFactoryName =
  | "createStorageWithBadCredentials"
  | "createStorageWithDeniedCredentials"
  | "createStorageWithExpiredCredentials"
  | "createStorageWithMissingBucket";

export interface ConformanceContext {
  readonly storage: Storage;
  readonly keyPrefix: string;
  readonly target: ConformanceTarget;
  declares(name: CapabilityName): boolean;
}
