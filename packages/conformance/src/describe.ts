import {
  cleanUp,
  type ConformanceRunOptions,
  createKeyPrefix,
  selectedCases,
  selectHalf,
  skipReasonFor,
  startRun,
  type SuiteCase,
  type SuiteContext,
  type SuiteTarget,
} from "./run.ts";
import type { ConformanceTarget } from "./target.ts";

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

/**
 * The mapping behind `describeConformance` and `describeHttpConformance`, over the cases a
 * caller picked, inside a `describe` named `suite`.
 */
export function describeCases<Target extends SuiteTarget>(
  sources: readonly SuiteCase<Target>[],
  target: Target,
  framework: ConformanceFramework,
  suite: string = target.name,
): void {
  const keyPrefix = createKeyPrefix();
  // `describe` registers its tests synchronously and has nothing to await the storage
  // in, so the run opens inside the first case that needs it and the rest share it.
  let opened: Promise<SuiteContext<Target>> | undefined;
  const open = async (): Promise<SuiteContext<Target>> =>
    await (opened ??= startRun(target, keyPrefix));

  framework.describe(suite, () => {
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

    // The cleanup of spec 14.2 is a test of its own for the same reason: `describe` and
    // `test` are all three frameworks share, and an `afterAll` is not among them.
    framework.test("cleanup", async () => await cleanUp(target, keyPrefix));
  });
}
