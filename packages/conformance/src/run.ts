import type { CapabilityName } from "@stowage/core";

import type { ConformanceCase, ConformanceCaseSource } from "./case.ts";
import { conformanceCaseSources } from "./cases/index.ts";
import type { ConformanceMode } from "./result.ts";
import type { ConformanceContext, ConformanceTarget } from "./target.ts";

export interface ConformanceRunOptions {
  includeSlow?: boolean;
}

/** The cases a run performs: the `fast` tier alone unless it asks for both (spec 8.2). */
export function selectedCases(options?: ConformanceRunOptions): readonly ConformanceCaseSource[] {
  if (options?.includeSlow === true) return conformanceCaseSources;

  return conformanceCaseSources.filter((source) => source.cost === "fast");
}

// Spec 8.2 puts every final key below one prefix and asks a case for a boundary key of
// exactly 1024 UTF-8 bytes, so the prefix stays ASCII and short enough to leave room for
// one, in segments the 255 bytes of spec 8.7 hold.
const keyPrefixRoot = "stowage-conformance";

export function createKeyPrefix(): string {
  return `${keyPrefixRoot}/${crypto.randomUUID()}/`;
}

/**
 * Spec 8.2: the declaration is read once per run, before the first case, because every
 * storage the target creates in one run declares the same.
 */
export async function startRun(
  target: ConformanceTarget,
  keyPrefix: string,
): Promise<ConformanceContext> {
  const storage = await target.createStorage();
  const declared = new Set<CapabilityName>(storage.capabilities);

  return { storage, keyPrefix, target, declares: (name) => declared.has(name) };
}

/**
 * Spec 8.2: the default deletes below the prefix on a storage of its own, so that a run
 * whose storage broke on the way still clears what it wrote.
 */
export async function cleanUp(target: ConformanceTarget, keyPrefix: string): Promise<void> {
  if (target.cleanup !== undefined) return await target.cleanup(keyPrefix);

  const storage = await target.createStorage();
  const report = await storage.deleteAll(keyPrefix);
  const [failure] = report.failed;

  if (failure !== undefined) throw failure;
}

/** The factory the case needs and the target left out, which spec 8.2 skips it for. */
export function skipReasonFor(
  source: ConformanceCaseSource,
  target: ConformanceTarget,
): string | undefined {
  if (source.factory === undefined || target[source.factory] !== undefined) return undefined;

  return source.factory;
}

export interface ConformanceHalf {
  readonly mode: ConformanceMode;
  run(): Promise<void>;
}

/**
 * Spec 8.2: a case whose requirements are all declared runs `run`, and one missing a
 * name runs `runWithout`.
 */
export function selectHalf(source: ConformanceCase, context: ConformanceContext): ConformanceHalf {
  // The union member carrying a requirement is the one that carries `runWithout`; a case
  // without a requirement has none it could be missing.
  if ("runWithout" in source && !source.requires.every((name) => context.declares(name))) {
    return { mode: "without", run: async () => await source.runWithout(context) };
  }

  return { mode: "declared", run: async () => await source.run(context) };
}
