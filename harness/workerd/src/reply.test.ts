import { expect, test } from "vitest";

import type { ConformanceCaseMetadata } from "../../../packages/conformance/src/case.ts";
import type { ConformanceFramework } from "../../../packages/conformance/src/describe.ts";
import { answerIn, describeCoreReply, describeResults, settled } from "./reply.ts";

interface RegisteredTest {
  readonly path: readonly string[];
  readonly body: () => Promise<void>;
}

/** The tests a report registers, each under the `describe` names it sits in. */
function recorded(report: (framework: ConformanceFramework) => void): readonly RegisteredTest[] {
  const tests: RegisteredTest[] = [];
  const blocks: string[] = [];

  report({
    describe(name, body) {
      blocks.push(name);
      body();
      blocks.pop();
    },
    test(name, body) {
      tests.push({ path: [...blocks, name], body });
    },
  });

  return tests;
}

function caseNamed(name: string): ConformanceCaseMetadata {
  return { name, requires: [], cost: "fast" };
}

test("a lost run reports one failed test under its `describe`, with the error of the request", async () => {
  const lost = new Error("The request for adapter-gcs at the flags of spec 1 failed");
  const reply = await settled(Promise.reject(lost));

  const [only, ...others] = recorded((framework) => {
    describeResults(framework, "@stowage/adapter-gcs", reply);
  });

  expect(others).toEqual([]);
  expect(only?.path).toEqual(["@stowage/adapter-gcs", "the request for the run"]);
  await expect(only?.body()).rejects.toBe(lost);
});

test("a run that came back reports each case as a test of its own", async () => {
  const reply = await settled(
    Promise.resolve([
      { case: caseNamed("get/missing-key"), status: "passed", mode: "declared" },
      { case: caseNamed("list/delimiter"), status: "skipped", reason: "no delimiter" },
      {
        case: caseNamed("put/overwrite"),
        status: "failed",
        mode: "declared",
        error: { name: "AssertionError", message: "expected the second body" },
      },
    ] as const),
  );

  const tests = recorded((framework) => {
    describeResults(framework, "@stowage/adapter-memory", reply);
  });

  expect(tests.map(({ path }) => path)).toEqual([
    ["@stowage/adapter-memory", "get/missing-key"],
    ["@stowage/adapter-memory", "list/delimiter (skipped: no delimiter)"],
    ["@stowage/adapter-memory", "put/overwrite"],
  ]);

  const [passed, skipped, failed] = tests;

  await expect(passed?.body()).resolves.toBeUndefined();
  await expect(skipped?.body()).resolves.toBeUndefined();
  await expect(failed?.body()).rejects.toMatchObject({
    name: "AssertionError",
    message: "expected the second body",
  });
});

test("a lost answer of the core checks reports one failed test under the core", async () => {
  const lost = new Error("fetch failed");
  const reply = await settled(Promise.reject(lost));

  const [only, ...others] = recorded((framework) => {
    describeCoreReply(framework, reply);
  });

  expect(others).toEqual([]);
  expect(only?.path).toEqual(["@stowage/core", "the request for the checks"]);
  await expect(only?.body()).rejects.toBe(lost);
});

test("a test reading a probe gets its answer, or the error of the lost request", async () => {
  const lost = new Error("fetch failed");

  expect(answerIn(await settled(Promise.resolve({ process: "undefined" })))).toEqual({
    process: "undefined",
  });

  const reply = await settled(Promise.reject(lost));
  let thrown: unknown;

  try {
    answerIn(reply);
  } catch (error) {
    thrown = error;
  }

  expect(thrown).toBe(lost);
});
