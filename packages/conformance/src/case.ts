import type { CapabilityName } from "@stowage/core";

import type { ConformanceContext, ConformanceFactoryName } from "./target.ts";

export type ConformanceCase =
  | {
      readonly name: string;
      readonly requires: readonly [];
      readonly cost: "fast" | "slow";
      run(ctx: ConformanceContext): Promise<void>;
    }
  | {
      readonly name: string;
      readonly requires: readonly [CapabilityName, ...CapabilityName[]];
      readonly cost: "fast" | "slow";
      run(ctx: ConformanceContext): Promise<void>;
      runWithout(ctx: ConformanceContext): Promise<void>;
    };

/**
 * A case as the suite writes it down: the published shape plus the factory of spec 9.3 it
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
