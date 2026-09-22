import type { ConformanceCaseSource } from "./case.ts";
import {
  cleanUp,
  type ConformanceRunOptions,
  createKeyPrefix,
  selectedCases,
  selectHalf,
  skipReasonFor,
  startRun,
} from "./run.ts";
import type { ConformanceContext, ConformanceTarget } from "./target.ts";

export interface ConformanceFramework extends ConformanceRunOptions {
  describe(name: string, body: () => void): void;
  test(name: string, body: () => Promise<void>): void;
}

/**
 * Maps every case onto one test of Vitest, `bun:test` or `Deno.test`, whose `describe`
 * and `test` agree in shape (ADR 0006), so that a failing case is a failing test of its
 * own rather than one red line covering the suite.
 */
export function describeConformance(
  target: ConformanceTarget,
  framework: ConformanceFramework,
): void {
  describeCases(selectedCases(framework), target, framework);
}

/** The mapping behind `describeConformance`, over the cases a caller picked. */
export function describeCases(
  sources: readonly ConformanceCaseSource[],
  target: ConformanceTarget,
  framework: ConformanceFramework,
): void {
  const keyPrefix = createKeyPrefix();
  // `describe` registers its tests synchronously and has nothing to await the storage
  // in, so the run opens inside the first case that needs it and the rest share it.
  let opened: Promise<ConformanceContext> | undefined;
  const open = async (): Promise<ConformanceContext> =>
    await (opened ??= startRun(target, keyPrefix));

  framework.describe(target.name, () => {
    for (const source of sources) {
      const skipped = skipReasonFor(source, target);

      if (skipped !== undefined) {
        // The reason belongs in the name: the three test functions agree on `test` and
        // not on a way to report a test that did not run.
        framework.test(`${source.name} (skipped: ${skipped})`, async () => {});
        continue;
      }

      framework.test(source.name, async () => {
        await selectHalf(source, await open()).run();
      });
    }

    // The cleanup of spec 8.2 is a test of its own for the same reason: `describe` and
    // `test` are all three frameworks share, and an `afterAll` is not among them.
    framework.test("cleanup", async () => await cleanUp(target, keyPrefix));
  });
}
