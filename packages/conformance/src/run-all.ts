import { type ConformanceCaseSource, metadataOf } from "./case.ts";
import { type ConformanceResult, serializeError } from "./result.ts";
import {
  cleanUp,
  type ConformanceRunOptions,
  createKeyPrefix,
  selectedCases,
  selectHalf,
  skipReasonFor,
  startRun,
} from "./run.ts";
import type { ConformanceTarget } from "./target.ts";

/**
 * Runs the cases without a test framework and reports them, which is how a runtime that
 * has none — `workerd` — runs the suite (ADR 0006). A failing case is one result among
 * the others; only a target that cannot produce a storage at all rejects the run.
 */
export async function runAll(
  target: ConformanceTarget,
  options?: ConformanceRunOptions,
): Promise<readonly ConformanceResult[]> {
  return await runCases(selectedCases(options), target);
}

/** One run over the cases a caller picked, which is what `runAll` is around the suite. */
export async function runCases(
  sources: readonly ConformanceCaseSource[],
  target: ConformanceTarget,
): Promise<readonly ConformanceResult[]> {
  const keyPrefix = createKeyPrefix();
  const context = await startRun(target, keyPrefix);
  const results: ConformanceResult[] = [];

  for (const source of sources) {
    const skipped = skipReasonFor(source, target);

    if (skipped !== undefined) {
      results.push({ case: metadataOf(source), status: "skipped", reason: skipped });
      continue;
    }

    const half = selectHalf(source, context);

    try {
      // oxlint-disable-next-line no-await-in-loop -- one storage, so the cases go in turn
      await half.run();
      results.push({ case: metadataOf(source), status: "passed", mode: half.mode });
    } catch (thrown) {
      results.push({
        case: metadataOf(source),
        status: "failed",
        mode: half.mode,
        error: serializeError(thrown),
      });
    }
  }

  await cleanUp(target, keyPrefix);

  return results;
}
