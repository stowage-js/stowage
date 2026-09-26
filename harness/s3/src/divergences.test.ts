import { describe, expect, test } from "vitest";

import { memoryStorage } from "../../../packages/adapter-memory/src/index.ts";
import type { ConformanceCaseSource } from "../../../packages/conformance/src/case.ts";
import { conformanceCaseSources } from "../../../packages/conformance/src/cases/index.ts";
import type { ConformanceContext } from "../../../packages/conformance/src/target.ts";
import { memoryTarget } from "../../targets/src/memory.ts";
import { type Divergence, divergences, withDivergences } from "./divergences.ts";

// The cases below read nothing off the context; a real one keeps the types honest.
const context: ConformanceContext = {
  storage: memoryStorage(),
  keyPrefix: "divergences/",
  target: memoryTarget,
  declares: () => false,
};

const passing: ConformanceCaseSource = {
  name: "list/delimiter",
  requires: [],
  cost: "fast",
  run: async () => {},
};

const failing = (message: string): ConformanceCaseSource => ({
  name: "list/delimiter",
  requires: [],
  cost: "fast",
  run: async () => {
    throw new Error(message);
  },
});

const entry: Divergence = {
  case: "list/delimiter",
  endpoint: "seaweedfs",
  differs: "It lists a pseudo-directory twice",
  failureMessagePart: "twice",
  settledBy: "aws-s3",
};

const runOnly = async (sources: readonly ConformanceCaseSource[]): Promise<void> => {
  const [source] = sources;

  if (source === undefined) throw new Error("No case to run");

  await source.run(context);
};

describe("withDivergences", () => {
  test("hands a case without an entry over as it is", () => {
    expect(withDivergences([passing], "seaweedfs", [])).toEqual([passing]);
  });

  test("hands a case over as it is against an endpoint the entry does not name", () => {
    expect(withDivergences([passing], "aws-s3", [entry])).toEqual([passing]);
  });

  test("passes a case that fails as its entry says", async () => {
    await expect(
      runOnly(withDivergences([failing("listed twice")], "seaweedfs", [entry])),
    ).resolves.toBeUndefined();
  });

  test("fails a case that passes against the endpoint its entry names", async () => {
    await expect(runOnly(withDivergences([passing], "seaweedfs", [entry]))).rejects.toThrow(
      "`list/delimiter` passed against seaweedfs",
    );
  });

  test("names the list to remove the entry from", async () => {
    await expect(
      runOnly(withDivergences([passing], "azurite", [{ ...entry, endpoint: "azurite" }], "a.ts")),
    ).rejects.toThrow("Remove the entry from `a.ts`");
  });

  test("hands on a failure its entry does not describe", async () => {
    await expect(
      runOnly(withDivergences([failing("the bucket is gone")], "seaweedfs", [entry])),
    ).rejects.toThrow("the bucket is gone");
  });

  test("expects the half without the capability to fail as well", async () => {
    const withoutHalf: ConformanceCaseSource = {
      name: "list/delimiter",
      requires: ["rangeReads"],
      cost: "fast",
      run: async () => {},
      runWithout: async () => {},
    };
    const [expected] = withDivergences([withoutHalf], "seaweedfs", [entry]);

    if (expected === undefined || !("runWithout" in expected)) throw new Error("No half");

    await expect(expected.runWithout(context)).rejects.toThrow("passed against seaweedfs");
  });
});

// ADR 0012: an entry is admissible only where the same case runs against a real endpoint,
// which is what keeps the list from being the accepted failure ADR 0006 rules out. The
// types hold the endpoints; the name of the case is what they cannot.
describe.each(divergences)("the entry for $case against $endpoint", (divergence) => {
  test("names a case of the suite", () => {
    expect(conformanceCaseSources.map((source) => source.name)).toContain(divergence.case);
  });
});
