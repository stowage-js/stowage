import type { CapabilityName, Storage } from "@stowage/core";

export interface ConformanceTarget {
  readonly name: string;
  createStorage(): Storage | Promise<Storage>;
  cleanup?(keyPrefix: string): Promise<void>;
  createStorageWithBadCredentials?(): Storage | Promise<Storage>;
  createStorageWithExpiredCredentials?(): Storage | Promise<Storage>;
  createStorageWithDeniedCredentials?(): Storage | Promise<Storage>;
  /**
   * A storage whose credential is stale: the provider refuses it, and a fresh one it passes
   * (spec 14.3). The resolver answers the stale credential until it is asked with
   * `forceRefresh: true`, the fresh one from then on whatever it is asked, and calls
   * `onRefresh` each time it is asked to refresh.
   */
  createStorageWithStaleCredentials?(onRefresh: () => void): Storage | Promise<Storage>;
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
  | "createStorageWithMissingBucket"
  | "createStorageWithStaleCredentials";

export interface ConformanceContext {
  readonly storage: Storage;
  readonly keyPrefix: string;
  readonly target: ConformanceTarget;
  declares(name: CapabilityName): boolean;
}
