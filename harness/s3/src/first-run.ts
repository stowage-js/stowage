import { excludedCases } from "../../workerd/src/excluded.ts";

declare module "vitest" {
  interface TaskMeta {
    /** What a probe of spec 12 saw where the point is a measurement and not a promise. */
    observed?: string;
  }
}

/** The block the probes of spec 12 are registered in, on Node and on `workerd` alike. */
export const firstRunSuite = "settled by the first run";

/** The block `describeConformance` registers the cases against the endpoint in. */
const s3Suite = "@stowage/adapter-s3";

export const probeNames = {
  entityTooSmall: "a completion over a part below 5 MiB answers `EntityTooSmall`",
  invalidPart: "a completion naming a part the provider does not hold answers `InvalidPart`",
  headWithoutBody: "`HEAD` is answered without a body",
  responseOverrides: "a presigned `GET` answers with the four response overrides",
  copyAboveLimit: "`copy` above the single-request limit",
} as const;

/** The test the `workerd` harness reports an excluded case's measurement under. */
export const measuredOnWorkerd = (name: string): string => `${name} measured on workerd`;

export interface FirstRunTest {
  readonly suite: string;
  readonly title: string;
}

export interface FirstRunPoint {
  /** The point as spec 12 states it. */
  readonly promise: string;
  /** The tests of the scheduled run that answer it. */
  readonly tests: readonly FirstRunTest[];
}

const probe = (title: string): FirstRunTest => ({ suite: firstRunSuite, title });
const conformanceCase = (title: string): FirstRunTest => ({ suite: s3Suite, title });

/** Spec 12, point by point, with what the scheduled run reads each one off. */
export const firstRunPoints: readonly FirstRunPoint[] = [
  {
    promise: "`EntityTooSmall` and `InvalidPart` are answered as this document maps them",
    tests: [probe(probeNames.entityTooSmall), probe(probeNames.invalidPart)],
  },
  {
    promise: "A presigned `PUT` enforces the `Content-Length` and `Content-Type` it signed",
    tests: [
      conformanceCase("presign/put-rejects-type"),
      conformanceCase("presign/put-rejects-length"),
    ],
  },
  {
    promise: "`HEAD` is answered without a body",
    tests: [probe(probeNames.headWithoutBody)],
  },
  {
    promise: "R2 honors the four response overrides on `presignGet`",
    tests: [probe(probeNames.responseOverrides)],
  },
  {
    promise: "R2 answers `ExpiredRequest` for an expired credential",
    tests: [conformanceCase("errors/expired-credentials")],
  },
  {
    promise: "The CPU and duration a multipart upload spends on `workerd`",
    tests: excludedCases.map((name) => probe(measuredOnWorkerd(name))),
  },
  {
    promise: "The refusal of `copy` above the single-request limit against a real provider",
    tests: [probe(probeNames.copyAboveLimit)],
  },
];
