import { expect, test } from "vitest";

import type { ConformanceCaseSource } from "./case.ts";
import { type ConformanceFramework, describeCases, describeConformance } from "./describe.ts";
import { selectedCases } from "./run.ts";
import { stubStorage } from "./stub-storage.ts";
import type { ConformanceTarget } from "./target.ts";

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

const passing = (name: string): ConformanceCaseSource => ({
  name,
  requires: [],
  cost: "fast",
  run: async () => {},
});

const target = (fields: Partial<ConformanceTarget> = {}): ConformanceTarget => ({
  name: "stub",
  createStorage: () => stubStorage(),
  ...fields,
});

const runEach = async (recorded: Recorder): Promise<void> => {
  // oxlint-disable-next-line no-await-in-loop -- a framework runs them one after another
  for (const body of recorded.tests.values()) await body();
};

test("every case becomes one test under the target's name, with the cleanup behind them", () => {
  const recorded = recorder();

  describeCases([passing("stub/one"), passing("stub/two")], target(), recorded.framework);

  expect(recorded.suites).toEqual(["stub"]);
  expect([...recorded.tests.keys()]).toEqual(["stub/one", "stub/two", "cleanup"]);
});

test("a test fails where its case throws", async () => {
  const recorded = recorder();
  const failing: ConformanceCaseSource = {
    ...passing("stub/fails"),
    run: async () => {
      throw new Error("no");
    },
  };

  describeCases([failing], target(), recorded.framework);

  await expect(recorded.tests.get("stub/fails")?.()).rejects.toThrow("no");
});

test("a case needing a factory the target leaves out names the reason in its test", () => {
  const recorded = recorder();
  const source: ConformanceCaseSource = {
    ...passing("stub/denied"),
    factory: "createStorageWithDeniedCredentials",
  };

  describeCases([source], target(), recorded.framework);

  expect([...recorded.tests.keys()]).toEqual([
    "stub/denied (skipped: createStorageWithDeniedCredentials)",
    "cleanup",
  ]);
});

test("the declaration is read once for the whole run, inside the first case", async () => {
  const read: string[] = [];
  const recorded = recorder();
  const source: ConformanceCaseSource = {
    ...passing("stub/reads"),
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
    [passing("stub/one")],
    target({ cleanup: async (prefix) => void cleaned.push(prefix) }),
    recorded.framework,
  );
  await runEach(recorded);

  expect(cleaned).toHaveLength(1);
  expect(cleaned[0]).toMatch(/^stowage-conformance\/.+\/$/);
});

test("`describeConformance` maps the suite's own cases and runs the `fast` tier", async () => {
  const recorded = recorder();

  describeConformance(
    target({ createStorage: () => stubStorage({ provider: "memory", bucket: "memory" }) }),
    recorded.framework,
  );

  expect([...recorded.tests.keys()]).toEqual([
    ...selectedCases().map((source) => source.name),
    "cleanup",
  ]);

  await runEach(recorded);
});
