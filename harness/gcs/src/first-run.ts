import { type FirstRunPoint, type FirstRunTest, firstRunSuite } from "../../s3/src/first-run.ts";
import { gcsBucket } from "./divergences.ts";

/** The block `describeCases` registers the cases against the endpoint in. */
const gcsSuite = "@stowage/adapter-gcs";

export const gcsProbeNames = {
  expiredToken: "an access token past its expiry is answered `401` with `error=invalid_token`",
  replacedGeneration: "`objects.get` pinned to a generation a writer replaced answers `404`",
  flowOneOnWorkerd: "flow/1-large-upload measured on workerd against the bucket",
} as const;

const bucket = [gcsBucket];

const probe = (title: string): FirstRunTest => ({ suite: firstRunSuite, title });
const conformanceCase = (title: string): FirstRunTest => ({ suite: gcsSuite, title });

/**
 * Spec 14 on `adapter-gcs` as it stood before the first run against the bucket, point by
 * point, with what the scheduled run reads each one off. A point stated as a promise holds or
 * is disproved; the one recorded reads what the run observed.
 */
export const gcsFirstRunPoints: readonly FirstRunPoint[] = [
  {
    promise:
      "GCS: an access token past its expiry is answered with `401` and `error=invalid_token`, which the repeat of spec 9.3 reads (ADR 0033)",
    tests: [probe(gcsProbeNames.expiredToken)],
    endpoints: bucket,
    runtime: "node",
  },
  {
    promise:
      "GCS: a `308` reaches the adapter as it is on `workerd`, so a resumable session runs there (ADR 0036)",
    tests: [conformanceCase("put/multipart-round-trip")],
    endpoints: bucket,
    runtime: "workerd",
  },
  {
    promise:
      "GCS: `objects.get` pinned to a generation that a writer replaced answers `404 notFound` (ADR 0040)",
    tests: [probe(gcsProbeNames.replacedGeneration)],
    endpoints: bucket,
    runtime: "node",
  },
  {
    promise:
      "GCS, recorded: the time and CPU of flow 1's 17 MiB upload on `workerd`, the token exchanges included (ADR 0039)",
    tests: [probe(gcsProbeNames.flowOneOnWorkerd)],
    endpoints: bucket,
    runtime: "workerd",
  },
];
