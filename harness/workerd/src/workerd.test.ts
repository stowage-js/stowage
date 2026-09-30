import { describe, expect, test } from "vitest";

import { azureProbeNames } from "../../azure-blob/src/first-run.ts";
import { gcsProbeNames } from "../../gcs/src/first-run.ts";
import { firstRunSuite } from "../../s3/src/first-run.ts";
import { describeWorkerd, observationOf } from "./describe-workerd.ts";

const { probes, flowOne } = await describeWorkerd({ describe, test });

/* oxlint-disable vitest/valid-title -- the measurement's block and name are the ones the
   spec 14 report reads, kept once in `first-run.ts` for both */

/**
 * Each measurement taken, with the report's name for it and the token exchanges the measured
 * request made before the upload: one at Entra for Azure, and for GCS the two of ADR 0034.
 */
const measurements = [
  {
    title: azureProbeNames.flowOneOnWorkerd,
    taken: flowOne.azureBlob,
    exchanges: "one token exchange",
  },
  {
    title: gcsProbeNames.flowOneOnWorkerd,
    taken: flowOne.gcs,
    exchanges: "the exchanges at STS and IAM Credentials",
  },
].flatMap(({ taken, ...named }) => (taken === undefined ? [] : [{ ...named, taken }]));

// Spec 14 asks what flow 1 costs here, which a failure of the case answers as well: the
// case's own result is reported beside the others, and this carries the measurement.
describe.skipIf(measurements.length === 0)(firstRunSuite, () => {
  for (const { title, taken, exchanges } of measurements) {
    // oxlint-disable-next-line vitest/expect-expect -- a measurement, which passes whatever it measured
    test(title, ({ task }) => {
      task.meta.observed = observationOf(taken, exchanges);
    });
  }
});

describe("the flags of spec 1", () => {
  test("leave the harness worker no Node API", () => {
    expect(probes.harness.nodeApi).toEqual({
      process: "undefined",
      Buffer: "undefined",
      "node:os": "rejected",
      "node:buffer": "rejected",
    });
  });

  // Without this, a probe that could not see a Node API at all would pass the test above.
  test("differ from the defaults, where the same worker reaches Node APIs", () => {
    expect(probes.defaults.nodeApi).toEqual({
      process: "object",
      Buffer: "function",
      "node:os": "loaded",
      "node:buffer": "loaded",
    });
  });
});

describe("`fromEnv` on `workerd`", () => {
  // ADR 0007: a missing `process` is a refusal naming the variable, not a
  // `ReferenceError`. Where an S3 endpoint is configured the worker also has an
  // `AWS_ACCESS_KEY_ID` binding, and without `process` it does not reach `fromEnv`.
  test("finds no `process` at the flags of spec 1 and names the missing variable", () => {
    expect(probes.harness.fromEnv).toEqual({
      refusal: {
        code: "InvalidCredentials",
        message: expect.stringContaining("AWS_ACCESS_KEY_ID"),
      },
    });
  });

  // Spec 7.3: under `nodejs_compat`, which the pinned date turns on by default, the
  // bindings of `workerd.capnp` reach `process.env`.
  test("reads the three variables from the bindings at the defaults", () => {
    expect(probes.defaults.fromEnv).toEqual({
      credentials: {
        accessKeyId: "access-key-from-binding",
        secretAccessKey: "secret-from-binding",
        sessionToken: "session-token-from-binding",
      },
    });
  });
});
