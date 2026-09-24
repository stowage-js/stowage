import { describe, expect, test } from "vitest";

import { type FirstRunRun, firstRunReport, type JsonAssertion } from "./first-run-report.ts";
import { firstRunSuite, probeNames } from "./first-run.ts";

const assertion = (overrides: Partial<JsonAssertion> & { title: string }): JsonAssertion => ({
  ancestorTitles: [firstRunSuite],
  status: "passed",
  failureMessages: [],
  meta: {},
  ...overrides,
});

const run = (label: string, ...assertions: JsonAssertion[]): FirstRunRun => ({
  label,
  results: { testResults: [{ assertionResults: assertions }] },
});

const cells = (line: string): string[] =>
  line
    .slice(1, -1)
    .split(" | ")
    .map((cell) => cell.trim());

/** The cell of the table row whose first cell holds `promise`, in the column of `label`. */
function cellOf(report: string, promise: string, label: string): string | undefined {
  const rows = report.split("\n").filter((line) => line.startsWith("|"));
  const [header = ""] = rows;
  const column = cells(header).indexOf(label);
  const row = rows.find((line) => cells(line)[0]?.includes(promise));

  return row === undefined ? undefined : cells(row)[column];
}

const headPoint = "`HEAD` is answered without a body";

describe("firstRunReport", () => {
  test("reads a probe that passed as a promise that held", () => {
    const report = firstRunReport([
      run("aws-s3-node-24", assertion({ title: probeNames.headWithoutBody })),
    ]);

    expect(cellOf(report, headPoint, "aws-s3-node-24")).toBe("held");
  });

  test("reads a probe that failed as a promise the run disproved, with the first line", () => {
    const report = firstRunReport([
      run(
        "r2-node-24",
        assertion({
          title: probeNames.headWithoutBody,
          status: "failed",
          failureMessages: ["AssertionError: 12 bytes followed the head\n    at probe.ts:1:1"],
        }),
      ),
    ]);

    expect(cellOf(report, headPoint, "r2-node-24")).toBe(
      "disproved: AssertionError: 12 bytes followed the head",
    );
  });

  test("reads a case the target supplied no factory for as a point not settled", () => {
    const report = firstRunReport([
      run(
        "r2-node-24",
        assertion({
          ancestorTitles: ["@stowage/adapter-s3"],
          title: "errors/expired-credentials (skipped: createStorageWithExpiredCredentials)",
        }),
      ),
    ]);

    expect(cellOf(report, "`ExpiredRequest`", "r2-node-24")).toBe(
      "not settled: no `createStorageWithExpiredCredentials`",
    );
  });

  test("carries what a probe observed", () => {
    const report = firstRunReport([
      run(
        "aws-s3-node-24",
        assertion({
          title: probeNames.copyAboveLimit,
          meta: { observed: "refused as `InvalidRequest`, 400 `InvalidRequest`: too large" },
        }),
      ),
    ]);

    expect(cellOf(report, "The refusal of `copy`", "aws-s3-node-24")).toBe(
      "refused as `InvalidRequest`, 400 `InvalidRequest`: too large",
    );
  });

  test("reads a point none of whose tests ran as not run", () => {
    const report = firstRunReport([run("aws-s3-node-24")]);

    expect(cellOf(report, headPoint, "aws-s3-node-24")).toBe("not run");
  });

  test("leaves a point out of a runtime that does not ask it", () => {
    const report = firstRunReport([run("aws-s3-workerd")]);

    expect(cellOf(report, headPoint, "aws-s3-workerd")).toBe("—");
  });

  test("leaves a point about R2 out of the columns of AWS S3", () => {
    const report = firstRunReport([
      run(
        "aws-s3-node-24",
        assertion({ ancestorTitles: ["@stowage/adapter-s3"], title: "errors/expired-credentials" }),
      ),
    ]);

    expect(cellOf(report, "`ExpiredRequest`", "aws-s3-node-24")).toBe("—");
  });

  test("reads the case against the endpoint and not the one of the same name against memory", () => {
    const report = firstRunReport([
      run(
        "aws-s3-node-24",
        assertion({
          ancestorTitles: ["@stowage/adapter-memory"],
          title: "presign/put-rejects-type",
        }),
      ),
    ]);

    expect(cellOf(report, "A presigned `PUT` enforces", "aws-s3-node-24")).toBe("not run");
  });

  test("keeps a pipe in a failure from breaking the table", () => {
    const report = firstRunReport([
      run(
        "aws-s3-node-24",
        assertion({
          title: probeNames.headWithoutBody,
          status: "failed",
          failureMessages: ["expected a | b"],
        }),
      ),
    ]);

    expect(report).toContain("disproved: expected a \\| b");
  });

  test("states what becomes of a disproved promise", () => {
    expect(firstRunReport([])).toContain("withdrawn from `docs/spec.md` in a minor release");
  });
});
