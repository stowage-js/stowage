import { describe, expect, test } from "vitest";

import { type FirstRunRun, firstRunReport, type JsonAssertion } from "./first-run-report.ts";
import { azureProbeNames } from "../../azure-blob/src/first-run.ts";
import { gcsProbeNames } from "../../gcs/src/first-run.ts";
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

  // Spec 14 wants the answer recorded, and a probe that disproved its point saw one.
  test("carries what a probe observed beside the failure that disproved the point", () => {
    const report = firstRunReport([
      run(
        "gcs-node-24",
        assertion({
          title: gcsProbeNames.expiredToken,
          status: "failed",
          failureMessages: ["AssertionError: expected 403 to be 401\n    at probe.ts:1:1"],
          meta: { observed: "403 3 s past the expiry, `forbidden`: expired" },
        }),
      ),
    ]);

    expect(cellOf(report, "past its expiry", "gcs-node-24")).toBe(
      "disproved: AssertionError: expected 403 to be 401; observed 403 3 s past the expiry, `forbidden`: expired",
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

  test("reads a probe against the Azure account in the account's column", () => {
    const report = firstRunReport([
      run("azure-blob-node-24", assertion({ title: azureProbeNames.responseOverrides })),
    ]);

    expect(cellOf(report, "three response overrides on `presignGet`", "azure-blob-node-24")).toBe(
      "held",
    );
  });

  test("leaves a point about Azure out of the columns of S3", () => {
    const report = firstRunReport([
      run("aws-s3-node-24", assertion({ title: azureProbeNames.responseOverrides })),
    ]);

    expect(cellOf(report, "three response overrides on `presignGet`", "aws-s3-node-24")).toBe("—");
  });

  test("leaves a point about S3 out of the columns of the Azure account", () => {
    const report = firstRunReport([
      run("azure-blob-node-24", assertion({ title: probeNames.headWithoutBody })),
    ]);

    expect(cellOf(report, headPoint, "azure-blob-node-24")).toBe("—");
  });

  test("reads a case against the account and not the one of the same name against S3", () => {
    const report = firstRunReport([
      run(
        "azure-blob-workerd",
        assertion({ ancestorTitles: ["@stowage/adapter-s3"], title: "list/noncharacter-key" }),
      ),
      run(
        "azure-blob-node-24",
        assertion({
          ancestorTitles: ["@stowage/adapter-azure-blob"],
          title: "list/noncharacter-key",
        }),
      ),
    ]);

    expect(cellOf(report, "holding `U+FFFE` is stored", "azure-blob-workerd")).toBe("not run");
    expect(cellOf(report, "holding `U+FFFE` is stored", "azure-blob-node-24")).toBe("held");
  });

  // Spec 14 and ADR 0036: the round trip sends a resumable session, which a `308` the
  // runtime followed or swallowed would break.
  test("reads the `308` on `workerd` off the multipart round trip against the GCS bucket", () => {
    const point = "a `308` reaches the adapter as it is on `workerd`";
    const roundTrip = assertion({
      ancestorTitles: ["@stowage/adapter-gcs"],
      title: "put/multipart-round-trip",
    });
    const report = firstRunReport([
      run("gcs-node-24", roundTrip),
      run("gcs-workerd", roundTrip),
      run("azure-blob-workerd", { ...roundTrip, ancestorTitles: ["@stowage/adapter-azure-blob"] }),
    ]);

    expect(cellOf(report, point, "gcs-workerd")).toBe("held");
    expect(cellOf(report, point, "gcs-node-24")).toBe("—");
    expect(cellOf(report, point, "azure-blob-workerd")).toBe("—");
  });

  test("reads the `DELETE` of a `U+FFFE` key off the case and the harness test against S3", () => {
    const point = "a `DELETE` of a key holding `U+FFFE`";
    const report = firstRunReport([
      run(
        "aws-s3-node-24",
        assertion({ ancestorTitles: ["@stowage/adapter-s3"], title: "list/noncharacter-key" }),
        assertion({
          ancestorTitles: ["adapter-s3 against the endpoint"],
          title: "a `delete` sends a key holding U+FFFE as a `DELETE` of its own",
        }),
      ),
      run(
        "r2-workerd",
        assertion({ ancestorTitles: ["@stowage/adapter-s3"], title: "list/noncharacter-key" }),
      ),
    ]);

    expect(cellOf(report, point, "aws-s3-node-24")).toBe("held");
    expect(cellOf(report, point, "r2-workerd")).toBe("—");
  });

  test("carries the duration and the CPU flow 1 spent on `workerd` against the account", () => {
    const report = firstRunReport([
      run(
        "azure-blob-workerd",
        assertion({
          title: azureProbeNames.flowOneOnWorkerd,
          meta: { observed: "passed in 6.2 s, 0.8 s of CPU in the `workerd` process" },
        }),
      ),
      run("azure-blob-node-24"),
    ]);

    expect(cellOf(report, "17 MiB upload of flow 1", "azure-blob-workerd")).toBe(
      "passed in 6.2 s, 0.8 s of CPU in the `workerd` process",
    );
    expect(cellOf(report, "17 MiB upload of flow 1", "azure-blob-node-24")).toBe("—");
  });

  test("reads the GCS probes on Node in the bucket's Node columns alone", () => {
    const expiredToken = assertion({
      title: gcsProbeNames.expiredToken,
      meta: { observed: "401 12 s past the expiry, `authError`: Invalid Credentials" },
    });
    const report = firstRunReport([
      run("gcs-node-24", expiredToken, assertion({ title: gcsProbeNames.replacedGeneration })),
      run("gcs-workerd", expiredToken),
      run("azure-blob-node-24", expiredToken),
    ]);

    expect(cellOf(report, "past its expiry", "gcs-node-24")).toBe(
      "401 12 s past the expiry, `authError`: Invalid Credentials",
    );
    expect(cellOf(report, "a generation that a writer replaced", "gcs-node-24")).toBe("held");
    expect(cellOf(report, "past its expiry", "gcs-workerd")).toBe("—");
    expect(cellOf(report, "past its expiry", "azure-blob-node-24")).toBe("—");
  });

  // ADR 0034: whether Google grants a token short enough is unverified, and where it does not
  // the probe skips itself with the refusal.
  test("reads a probe that skipped itself with what it saw as a point not settled", () => {
    const report = firstRunReport([
      run(
        "gcs-node-26",
        assertion({
          title: gcsProbeNames.expiredToken,
          status: "skipped",
          meta: { observed: "no token for 60 s: Invalid lifetime." },
        }),
      ),
    ]);

    expect(cellOf(report, "past its expiry", "gcs-node-26")).toBe(
      "not settled: no token for 60 s: Invalid lifetime.",
    );
  });

  test("carries the duration and the CPU flow 1 spent on `workerd` against the GCS bucket", () => {
    const observed = "passed in 9.4 s, 1.1 s of CPU in the `workerd` process";
    const report = firstRunReport([
      run("gcs-workerd", assertion({ title: gcsProbeNames.flowOneOnWorkerd, meta: { observed } })),
      run("azure-blob-workerd", assertion({ title: gcsProbeNames.flowOneOnWorkerd })),
    ]);

    expect(cellOf(report, "time and CPU of flow 1", "gcs-workerd")).toBe(observed);
    expect(cellOf(report, "time and CPU of flow 1", "azure-blob-workerd")).toBe("—");
  });

  test("states what becomes of a disproved promise", () => {
    expect(firstRunReport([])).toContain("withdrawn from `docs/spec.md` in a minor release");
  });
});
