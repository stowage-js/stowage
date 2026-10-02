import type { CapabilityName, Storage } from "@stowage/core";

import type { CaseOf } from "./case.ts";

export interface HttpConformanceTarget {
  readonly name: string;
  /** A storage that addresses the objects the server serves, through which a case seeds them. */
  createStorage(): Storage | Promise<Storage>;
  /**
   * The route that gives one answer for one key, configured as spec 14.8 fixes it. How the
   * key travels in the URL is the target's.
   */
  url(answer: "serve" | "redirect" | "upload" | "presign", key: string): URL;
  cleanup?(keyPrefix: string): Promise<void>;
}

export interface HttpConformanceContext {
  readonly storage: Storage;
  readonly keyPrefix: string;
  readonly target: HttpConformanceTarget;
  declares(name: CapabilityName): boolean;
}

export type HttpConformanceCase = CaseOf<HttpConformanceContext>;
