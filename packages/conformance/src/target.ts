import type { CapabilityName, Storage } from "@stowage/core";

export interface ConformanceTarget {
  readonly name: string;
  createStorage(): Storage | Promise<Storage>;
  cleanup?(keyPrefix: string): Promise<void>;
  createStorageWithBadCredentials?(): Storage | Promise<Storage>;
  createStorageWithExpiredCredentials?(): Storage | Promise<Storage>;
  createStorageWithDeniedCredentials?(): Storage | Promise<Storage>;
}

/** The credential factories of spec 8.3, each of which a target may leave out. */
export type ConformanceFactoryName =
  | "createStorageWithBadCredentials"
  | "createStorageWithDeniedCredentials"
  | "createStorageWithExpiredCredentials";

export interface ConformanceContext {
  readonly storage: Storage;
  readonly keyPrefix: string;
  readonly target: ConformanceTarget;
  declares(name: CapabilityName): boolean;
}
