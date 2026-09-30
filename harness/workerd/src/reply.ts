import type { ConformanceFramework } from "../../../packages/conformance/src/describe.ts";
import type { ConformanceResult } from "../../../packages/conformance/src/result.ts";
import {
  type CoreCheckResult,
  coreSuiteName,
  describeCoreResults,
} from "../../targets/src/core.ts";

/**
 * What one request to the worker came back with: its answer, or the error that stands in
 * for it. A request that fails is reported where its answer would have been, so that the
 * answers of the others still reach the report (#258).
 */
export type Reply<T> = PromiseSettledResult<T>;

export async function settled<T>(request: Promise<T>): Promise<Reply<T>> {
  try {
    return { status: "fulfilled", value: await request };
  } catch (reason) {
    return { status: "rejected", reason };
  }
}

/** The answer, for a test to assert on, which a lost request fails with the error of the request. */
export function answerIn<T>(reply: Reply<T>): T {
  if (reply.status === "rejected") throw reply.reason;

  return reply.value;
}

/** The results of one run in the worker, each case a test named as `describeConformance` names it. */
export function describeResults(
  framework: ConformanceFramework,
  name: string,
  reply: Reply<readonly ConformanceResult[]>,
): void {
  framework.describe(name, () => {
    if (reply.status === "rejected") {
      framework.test("the request for the run", async () => {
        throw reply.reason;
      });
      return;
    }

    for (const result of reply.value) {
      if (result.status === "skipped") {
        framework.test(`${result.case.name} (skipped: ${result.reason})`, async () => {});
        continue;
      }

      framework.test(result.case.name, async () => {
        if (result.status === "failed") throw Object.assign(new Error(), result.error);
      });
    }
  });
}

/** The answer of the core checks in the worker, reported as `describeCore` names them. */
export function describeCoreReply(
  framework: ConformanceFramework,
  reply: Reply<readonly CoreCheckResult[]>,
): void {
  if (reply.status === "fulfilled") {
    describeCoreResults(framework, reply.value);
    return;
  }

  framework.describe(coreSuiteName, () => {
    framework.test("the request for the checks", async () => {
      throw reply.reason;
    });
  });
}
