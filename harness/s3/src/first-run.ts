import type { AzureBlobRealEndpoint } from "../../azure-blob/src/divergences.ts";
import type { GcsRealEndpoint } from "../../gcs/src/divergences.ts";
import { type RealEndpoint, realEndpoints } from "./configuration.ts";

declare module "vitest" {
  interface TaskMeta {
    /** What a probe saw beyond passing, where the provider may answer more than one way. */
    observed?: string;
  }
}

/** The real endpoints of the scheduled run, each of which is a column of the report. */
export type ReportedEndpoint = RealEndpoint | AzureBlobRealEndpoint | GcsRealEndpoint;

/** The block the probes of spec 14 are registered in, against S3 and Azure alike. */
export const firstRunSuite = "settled by the first run";

/** The block `describeConformance` registers the cases against the endpoint in. */
const s3Suite = "@stowage/adapter-s3";

/** The block `adapter-s3.test.ts` holds spec 10.4 against the endpoint in. */
const endpointSuite = "adapter-s3 against the endpoint";

export const probeNames = {
  entityTooSmall: "a completion over a part below 5 MiB answers `EntityTooSmall`",
  invalidPart: "a completion naming a part the provider does not hold answers `InvalidPart`",
  headWithoutBody: "`HEAD` is answered without a body",
  responseOverrides: "a presigned `GET` answers with the four response overrides",
  copyAboveLimit: "`copy` above the single-request limit",
} as const;

export interface FirstRunTest {
  readonly suite: string;
  readonly title: string;
}

export interface FirstRunPoint {
  /** The point as spec 14 stated it before the first run. */
  readonly promise: string;
  /** The tests of the scheduled run that answer it. */
  readonly tests: readonly FirstRunTest[];
  /**
   * The endpoints the point is asked of: a point about R2 is not settled against AWS, and
   * none about S3 against the Azure account.
   */
  readonly endpoints: readonly ReportedEndpoint[];
  /** The runtime the point is asked on, where not every one: a probe on Node alone. */
  readonly runtime?: string;
}

const probe = (title: string): FirstRunTest => ({ suite: firstRunSuite, title });
const conformanceCase = (title: string): FirstRunTest => ({ suite: s3Suite, title });

/**
 * Spec 14 as it stood before the first run, point by point, with what the scheduled run reads
 * each one off. The run keeps asking once a point moved into the section it belongs to.
 */
export const s3FirstRunPoints: readonly FirstRunPoint[] = [
  {
    promise: "`EntityTooSmall` and `InvalidPart` are answered as this document maps them",
    tests: [probe(probeNames.entityTooSmall), probe(probeNames.invalidPart)],
    endpoints: realEndpoints,
    runtime: "node",
  },
  {
    promise: "A presigned `PUT` enforces the `Content-Length` and `Content-Type` it signed",
    tests: [
      conformanceCase("presign/put-rejects-type"),
      conformanceCase("presign/put-rejects-length"),
    ],
    endpoints: realEndpoints,
  },
  {
    promise: "`HEAD` is answered without a body",
    tests: [probe(probeNames.headWithoutBody)],
    endpoints: realEndpoints,
    runtime: "node",
  },
  {
    promise: "R2 honors the four response overrides on `presignGet`",
    tests: [probe(probeNames.responseOverrides)],
    endpoints: ["r2"],
    runtime: "node",
  },
  {
    promise: "R2 answers `ExpiredRequest` for an expired credential",
    tests: [conformanceCase("errors/expired-credentials")],
    endpoints: ["r2"],
  },
  {
    promise:
      "`adapter-s3`: a `DELETE` of a key holding `U+FFFE` answers `204` and removes the object (ADR 0027)",
    tests: [
      conformanceCase("list/noncharacter-key"),
      {
        suite: endpointSuite,
        title: "a `delete` sends a key holding U+FFFE as a `DELETE` of its own",
      },
    ],
    endpoints: realEndpoints,
    // The harness test that sees the `DELETE` go out on its own runs on Node alone.
    runtime: "node",
  },
  {
    promise: "The refusal of `copy` above the single-request limit against a real provider",
    tests: [probe(probeNames.copyAboveLimit)],
    endpoints: realEndpoints,
    // The provider's limit is no property of the Node line, so one line uploads the 5 GiB.
    runtime: "node-24",
  },
];
