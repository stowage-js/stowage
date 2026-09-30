import type { FirstRunPoint, FirstRunTest } from "../../s3/src/first-run.ts";
import { gcsBucket } from "./divergences.ts";

/** The block `describeCases` registers the cases against the endpoint in. */
const gcsSuite = "@stowage/adapter-gcs";

const bucket = [gcsBucket];

const conformanceCase = (title: string): FirstRunTest => ({ suite: gcsSuite, title });

/**
 * Spec 14 on `adapter-gcs` as it stood before the first run against the bucket, point by
 * point, with what the scheduled run reads each one off. The probes beyond the suite join
 * with the tests that ask them.
 */
export const gcsFirstRunPoints: readonly FirstRunPoint[] = [
  {
    promise:
      "GCS: a `308` reaches the adapter as it is on `workerd`, so a resumable session runs there (ADR 0036)",
    tests: [conformanceCase("put/multipart-round-trip")],
    endpoints: bucket,
    runtime: "workerd",
  },
];
