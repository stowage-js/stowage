import type { CapabilityName } from "@stowage/core";

import type { ConformanceContext, ConformanceFactoryName } from "./target.ts";

/**
 * A case of either list against the context its suite hands it: the conformance suite of
 * spec 14.1 and the HTTP conformance suite of spec 14.8 share the shape and differ in
 * the context alone.
 */
export type CaseOf<Context> =
  | {
      readonly name: string;
      readonly requires: readonly [];
      readonly cost: "fast" | "slow";
      run(ctx: Context): Promise<void>;
    }
  | {
      readonly name: string;
      readonly requires: readonly [CapabilityName, ...CapabilityName[]];
      readonly cost: "fast" | "slow";
      run(ctx: Context): Promise<void>;
      runWithout(ctx: Context): Promise<void>;
    };

export type ConformanceCase = CaseOf<ConformanceContext>;

/**
 * A case as the suite writes it down: the published shape plus the factory of spec 14.3 it
 * needs. `ConformanceCase` leaves the factory out because it says what a target supplies
 * and nothing a harness decides from.
 */
export type ConformanceCaseSource = ConformanceCase & {
  readonly factory?: ConformanceFactoryName;
};

export interface ConformanceCaseMetadata {
  readonly name: string;
  readonly requires: readonly CapabilityName[];
  readonly cost: "fast" | "slow";
}

// ADR 0006: a result carries the three fields copied out rather than the case, so that a
// harness serializing it does not carry the `run` function of every case it ran.
export function metadataOf(source: ConformanceCase): ConformanceCaseMetadata {
  return { name: source.name, requires: [...source.requires], cost: source.cost };
}
