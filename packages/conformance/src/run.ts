import type { CapabilityName, Storage } from "@stowage/core";

import type { CaseOf, ConformanceCaseSource } from "./case.ts";
import { conformanceCaseSources } from "./cases/index.ts";
import type { ConformanceMode } from "./result.ts";

export interface ConformanceRunOptions {
  includeSlow?: boolean;
}

/**
 * What a run asks of a target, which `ConformanceTarget` and `HttpConformanceTarget` both
 * carry: spec 14.8 has the HTTP suite run as spec 14.2 has the first one run.
 */
export interface SuiteTarget {
  readonly name: string;
  createStorage(): Storage | Promise<Storage>;
  cleanup?(keyPrefix: string): Promise<void>;
}

export interface SuiteContext<Target extends SuiteTarget> {
  readonly storage: Storage;
  readonly keyPrefix: string;
  readonly target: Target;
  declares(name: CapabilityName): boolean;
}

/** A case of either list, with the optional factory of its target it cannot run without. */
export type SuiteCase<Target extends SuiteTarget> = CaseOf<SuiteContext<Target>> & {
  readonly factory?: keyof Target & string;
};

/** The cases a run performs: the `fast` tier alone unless it asks for both (spec 14.2). */
export function selectedCases(options?: ConformanceRunOptions): readonly ConformanceCaseSource[] {
  return casesOfTier(conformanceCaseSources, options);
}

export function casesOfTier<Source extends { readonly cost: "fast" | "slow" }>(
  sources: readonly Source[],
  options?: ConformanceRunOptions,
): readonly Source[] {
  if (options?.includeSlow === true) return sources;

  return sources.filter((source) => source.cost === "fast");
}

// Spec 14.2 puts every final key below one prefix and asks a case for a boundary key of
// exactly 1024 UTF-8 bytes, so the prefix stays ASCII and short enough to leave room for
// one, in segments the 255 bytes of spec 14.7 hold.
const keyPrefixRoot = "stowage-conformance";

export function createKeyPrefix(): string {
  return `${keyPrefixRoot}/${crypto.randomUUID()}/`;
}

/**
 * Spec 14.2: the declaration is read once per run, before the first case, because every
 * storage the target creates in one run declares the same.
 */
export async function startRun<Target extends SuiteTarget>(
  target: Target,
  keyPrefix: string,
): Promise<SuiteContext<Target>> {
  const storage = await target.createStorage();
  const declared = new Set<CapabilityName>(storage.capabilities);

  return { storage, keyPrefix, target, declares: (name) => declared.has(name) };
}

/**
 * Spec 14.2: the default deletes below the prefix on a storage of its own, so that a run
 * whose storage broke on the way still clears what it wrote.
 */
export async function cleanUp(target: SuiteTarget, keyPrefix: string): Promise<void> {
  if (target.cleanup !== undefined) return await target.cleanup(keyPrefix);

  const storage = await target.createStorage();
  const report = await storage.deleteAll(keyPrefix);
  const [failure] = report.failed;

  if (failure !== undefined) throw failure;
}

/** The factory the case needs and the target left out, which spec 14.2 skips it for. */
export function skipReasonFor<Target extends SuiteTarget>(
  source: SuiteCase<Target>,
  target: Target,
): string | undefined {
  if (source.factory === undefined || target[source.factory] !== undefined) return undefined;

  return source.factory;
}

export interface ConformanceHalf {
  readonly mode: ConformanceMode;
  run(): Promise<void>;
}

/**
 * Spec 14.2: a case whose requirements are all declared runs `run`, and one missing a
 * name runs `runWithout`.
 */
export function selectHalf<Context extends { declares(name: CapabilityName): boolean }>(
  source: CaseOf<Context>,
  context: Context,
): ConformanceHalf {
  // The union member carrying a requirement is the one that carries `runWithout`; a case
  // without a requirement has none it could be missing.
  if ("runWithout" in source && !source.requires.every((name) => context.declares(name))) {
    return { mode: "without", run: async () => await source.runWithout(context) };
  }

  return { mode: "declared", run: async () => await source.run(context) };
}
