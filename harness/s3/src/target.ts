import type { S3AdapterOptions } from "../../../packages/adapter-s3/src/index.ts";
import { s3Storage } from "../../../packages/adapter-s3/src/index.ts";
import type { ConformanceTarget } from "../../../packages/conformance/src/target.ts";
import {
  storageWithBadCredentials,
  storageWithDeniedCredentials,
  type Variables,
} from "./configuration.ts";

/**
 * `adapter-s3` against the endpoint of ADR 0012, as every runtime's harness runs it. The
 * default cleanup of spec 8.2 is the one wanted: a fresh storage deleting below the prefix.
 */
export function s3Target(configured: S3AdapterOptions, variables: Variables): ConformanceTarget {
  const denied = storageWithDeniedCredentials(configured, variables);

  return {
    name: "@stowage/adapter-s3",

    createStorage: () => s3Storage(configured),

    createStorageWithBadCredentials: () => s3Storage(storageWithBadCredentials(configured)),

    // Spec 8.2 keeps the case out of a run where the target supplies no factory, which is
    // what an endpoint without the second identity of `s3.json` leaves.
    ...(denied === undefined
      ? {}
      : { createStorageWithDeniedCredentials: () => s3Storage(denied) }),
  };
}

// ADR 0012: a run includes this tier and fails where no endpoint is reachable rather than
// passing with it skipped. One failure says so, in place of the same reason repeated over
// every case the run then registers none of.
export const endpointConfiguredTest =
  "the S3 endpoint of ADR 0012 is configured (see `harness/s3/README.md`)";
