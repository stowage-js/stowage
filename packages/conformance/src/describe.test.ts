import { expect, test } from "vitest";

import type { Storage } from "@stowage/core";

import type { ConformanceCaseSource } from "./case.ts";
import { type ConformanceFramework, describeCases, describeConformance } from "./describe.ts";
import { selectedCases } from "./run.ts";
import { passingCase, stubStorage, stubTarget } from "./stubs.ts";

interface Recorder {
  readonly suites: readonly string[];
  readonly tests: ReadonlyMap<string, () => Promise<void>>;
  readonly framework: ConformanceFramework;
}

const recorder = (options: { includeSlow?: boolean } = {}): Recorder => {
  const suites: string[] = [];
  const tests = new Map<string, () => Promise<void>>();

  return {
    suites,
    tests,
    framework: {
      ...options,
      describe: (name, body) => {
        suites.push(name);
        body();
      },
      test: (name, body) => void tests.set(name, body),
    },
  };
};

/** One storage for every factory of spec 8.3, so that a target supplies all of them. */
const createStorage = (): Storage => stubStorage({ provider: "memory", bucket: "memory" });

const runEach = async (recorded: Recorder): Promise<void> => {
  // oxlint-disable-next-line no-await-in-loop -- a framework runs them one after another
  for (const body of recorded.tests.values()) await body();
};

test("every case becomes one test under the target's name, with the cleanup behind them", () => {
  const recorded = recorder();

  describeCases(
    [passingCase("stub/one"), passingCase("stub/two")],
    stubTarget(),
    recorded.framework,
  );

  expect(recorded.suites).toEqual(["stub"]);
  expect([...recorded.tests.keys()]).toEqual(["stub/one", "stub/two", "cleanup"]);
});

test("a test fails where its case throws", async () => {
  const recorded = recorder();
  const failing: ConformanceCaseSource = {
    ...passingCase("stub/fails"),
    run: async () => {
      throw new Error("no");
    },
  };

  describeCases([failing], stubTarget(), recorded.framework);

  await expect(recorded.tests.get("stub/fails")?.()).rejects.toThrow("no");
});

test("a case needing a factory the target leaves out names the reason in its test", () => {
  const recorded = recorder();
  const source: ConformanceCaseSource = {
    ...passingCase("stub/denied"),
    factory: "createStorageWithDeniedCredentials",
  };

  describeCases([source], stubTarget(), recorded.framework);

  expect([...recorded.tests.keys()]).toEqual([
    "stub/denied (skipped: createStorageWithDeniedCredentials)",
    "cleanup",
  ]);
});

test("the declaration is read once for the whole run, inside the first case", async () => {
  const read: string[] = [];
  const recorded = recorder();
  const source: ConformanceCaseSource = {
    ...passingCase("stub/reads"),
    run: async () => void read.push("case"),
  };

  describeCases(
    [source, { ...source, name: "stub/reads-again" }],
    {
      name: "stub",
      createStorage: () => {
        read.push("createStorage");

        return stubStorage();
      },
      cleanup: async () => void read.push("cleanup"),
    },
    recorded.framework,
  );

  expect(read).toEqual([]);

  await runEach(recorded);

  expect(read).toEqual(["createStorage", "case", "case", "cleanup"]);
});

test("the cleanup test deletes below the run's prefix", async () => {
  const cleaned: string[] = [];
  const recorded = recorder();

  describeCases(
    [passingCase("stub/one")],
    stubTarget({ cleanup: async (prefix) => void cleaned.push(prefix) }),
    recorded.framework,
  );
  await runEach(recorded);

  expect(cleaned).toHaveLength(1);
  expect(cleaned[0]).toMatch(/^stowage-conformance\/.+\/$/);
});

test("`describeConformance` maps the suite's own `fast` cases onto the framework", () => {
  const recorded = recorder();

  // The bodies stay unrun here: the cases need a storage to write to, and reading them
  // against a real adapter is what `test/conformance-memory.test.ts` does. The target
  // supplies every factory of spec 8.3, so that no case is skipped and each one arrives
  // under its own name.
  describeConformance(
    stubTarget({
      createStorage,
      createStorageWithBadCredentials: createStorage,
      createStorageWithDeniedCredentials: createStorage,
      createStorageWithExpiredCredentials: createStorage,
    }),
    recorded.framework,
  );

  expect([...recorded.tests.keys()]).toEqual([
    ...selectedCases().map((source) => source.name),
    "cleanup",
  ]);
});
