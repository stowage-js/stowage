import { invalidKeyReason, StorageError } from "@stowage/core";
import { expect, test } from "vitest";

import type { ConformanceCaseSource } from "./case.ts";
import { conformanceCaseSources } from "./cases/index.ts";
import { runAll, runCases } from "./run-all.ts";
import { createKeyPrefix, selectedCases } from "./run.ts";
import { passingCase, stubStorage, stubTarget } from "./stubs.ts";
import type { ConformanceContext } from "./target.ts";

const utf8 = new TextEncoder();

const costs = (selected: readonly ConformanceCaseSource[]): readonly string[] => [
  ...new Set(selected.map((source) => source.cost)),
];

test("a run puts every key below one prefix short enough for the boundary key", () => {
  const keyPrefix = createKeyPrefix();

  expect(invalidKeyReason(keyPrefix, "prefix")).toBeUndefined();
  expect(keyPrefix.endsWith("/")).toBe(true);
  // Spec 8.2 counts the prefix into the 1024 UTF-8 bytes of the boundary key, which spec
  // 8.7 builds in segments of at most 255, so what the prefix leaves has to hold several
  // whole segments.
  expect(1024 - utf8.encode(keyPrefix).length).toBeGreaterThan(3 * 256);
});

test("two runs against one bucket do not share a prefix", () => {
  expect(new Set([createKeyPrefix(), createKeyPrefix(), createKeyPrefix()]).size).toBe(3);
});

test("the `fast` tier runs by default and both tiers run with `includeSlow`", () => {
  expect(costs(selectedCases())).toEqual(["fast"]);
  expect(costs(selectedCases({ includeSlow: false }))).toEqual(["fast"]);
  expect(selectedCases({ includeSlow: true })).toEqual(conformanceCaseSources);
  // Every case of the suite is `fast` today, so the two tiers hold the same cases and
  // what tells them apart is the cost the filter reads rather than what it returns here.
  expect(costs(conformanceCaseSources)).toEqual(["fast"]);
});

test("a case that returns is reported as passed, naming the half that ran", async () => {
  const results = await runCases([passingCase("stub/passes")], stubTarget());

  expect(results).toEqual([
    {
      case: { name: "stub/passes", requires: [], cost: "fast" },
      status: "passed",
      mode: "declared",
    },
  ]);
});

test("a case whose requirement is declared runs `run`", async () => {
  const ran: string[] = [];
  const source: ConformanceCaseSource = {
    name: "stub/ranges",
    requires: ["rangeReads"],
    cost: "fast",
    run: async () => void ran.push("run"),
    runWithout: async () => void ran.push("runWithout"),
  };

  const results = await runCases(
    [source],
    stubTarget({ createStorage: () => stubStorage({ capabilities: ["rangeReads"] }) }),
  );

  expect(ran).toEqual(["run"]);
  expect(results[0]).toMatchObject({ status: "passed", mode: "declared" });
});

test("a case missing a requirement runs `runWithout`", async () => {
  const ran: string[] = [];
  const source: ConformanceCaseSource = {
    name: "stub/ranges",
    requires: ["rangeReads"],
    cost: "fast",
    run: async () => void ran.push("run"),
    runWithout: async () => void ran.push("runWithout"),
  };

  const results = await runCases([source], stubTarget());

  expect(ran).toEqual(["runWithout"]);
  expect(results[0]).toMatchObject({
    case: { name: "stub/ranges", requires: ["rangeReads"], cost: "fast" },
    status: "passed",
    mode: "without",
  });
});

test("a case needing a factory the target leaves out is skipped with the factory's name", async () => {
  const source: ConformanceCaseSource = {
    ...passingCase("stub/denied"),
    factory: "createStorageWithDeniedCredentials",
  };

  expect(await runCases([source], stubTarget())).toEqual([
    {
      case: { name: "stub/denied", requires: [], cost: "fast" },
      status: "skipped",
      reason: "createStorageWithDeniedCredentials",
    },
  ]);
});

test("a case needing a factory the target supplies runs", async () => {
  const source: ConformanceCaseSource = {
    ...passingCase("stub/denied"),
    factory: "createStorageWithDeniedCredentials",
  };

  const results = await runCases(
    [source],
    stubTarget({ createStorageWithDeniedCredentials: () => stubStorage() }),
  );

  expect(results[0]).toMatchObject({ status: "passed" });
});

test("a thrown value reaches the result as its name and its message", async () => {
  const source: ConformanceCaseSource = {
    ...passingCase("stub/fails"),
    run: async () => {
      throw new RangeError("out of bounds");
    },
  };

  const [result] = await runCases([source], stubTarget());

  expect(result).toMatchObject({ status: "failed", mode: "declared" });
  expect(result).toHaveProperty("error.name", "RangeError");
  expect(result).toHaveProperty("error.message", "out of bounds");
  expect(result).toHaveProperty("error.stack", expect.stringContaining("RangeError"));
});

test("a thrown `StorageError` reaches the result with its code and without its cause", async () => {
  const source: ConformanceCaseSource = {
    ...passingCase("stub/fails"),
    run: async () => {
      throw new StorageError({
        code: "NotFound",
        message: "No object under the key",
        operation: "get",
        bucket: "stub",
        provider: "stub",
        attempts: 1,
        cause: new Error("the one underneath"),
      });
    },
  };

  const [result] = await runCases([source], stubTarget());

  expect(result).toHaveProperty("error.code", "NotFound");
  expect(result).not.toHaveProperty("error.cause");
});

test("a failing case does not stop the ones behind it", async () => {
  const failing: ConformanceCaseSource = {
    ...passingCase("stub/fails"),
    run: async () => {
      throw new Error("no");
    },
  };

  const results = await runCases([failing, passingCase("stub/passes")], stubTarget());

  expect(results.map((result) => result.status)).toEqual(["failed", "passed"]);
});

test("the declaration is read once per run, before the first case", async () => {
  const read: string[] = [];
  const source: ConformanceCaseSource = {
    ...passingCase("stub/reads"),
    run: async () => void read.push("case"),
  };

  await runCases([source, { ...source, name: "stub/reads-again" }], {
    name: "stub",
    createStorage: () => {
      read.push("createStorage");

      return stubStorage();
    },
    cleanup: async () => {},
  });

  expect(read).toEqual(["createStorage", "case", "case"]);
});

test("the default cleanup deletes below the prefix on a storage of its own", async () => {
  const deleted: string[] = [];
  let storages = 0;
  const run = stubTarget({
    createStorage: () => {
      storages += 1;

      return stubStorage({
        deleteAll: async (prefix) => {
          deleted.push(prefix);

          return { requested: 0, failed: [] };
        },
      });
    },
  });

  await runCases([passingCase("stub/passes")], run);

  expect(storages).toBe(2);
  expect(deleted).toHaveLength(1);
  expect(deleted[0]).toMatch(/^stowage-conformance\//);
});

test("a target's own cleanup is called with the run's prefix instead", async () => {
  const cleaned: string[] = [];
  let ranPrefix: string | undefined;
  const source: ConformanceCaseSource = {
    ...passingCase("stub/reads"),
    run: async (ctx: ConformanceContext) => void (ranPrefix = ctx.keyPrefix),
  };

  await runCases([source], stubTarget({ cleanup: async (prefix) => void cleaned.push(prefix) }));

  expect(cleaned).toEqual([ranPrefix]);
});

test("`runAll` runs the suite's own cases against a target", async () => {
  const results = await runAll(
    stubTarget({ createStorage: () => stubStorage({ provider: "memory", bucket: "memory" }) }),
  );

  expect(results.map((result) => result.case.name)).toEqual(
    selectedCases().map((source) => source.name),
  );
  expect(results.every((result) => result.status === "passed")).toBe(true);
});
