import { describe, expect, test } from "vitest";

import { type S3AdapterOptions, s3Storage } from "../../../packages/adapter-s3/src/index.ts";
import type { ConformanceCaseSource } from "../../../packages/conformance/src/case.ts";
import { describeCases } from "../../../packages/conformance/src/describe.ts";
import { selectedCases } from "../../../packages/conformance/src/run.ts";
import type { ConformanceTarget } from "../../../packages/conformance/src/target.ts";
import {
  configuredStorage,
  storageWithBadCredentials,
  storageWithDeniedCredentials,
} from "./environment.ts";

/**
 * The operations `adapter-s3` has not been built yet, each named by the case it leaves
 * unrun. The list shrinks as they land: the listing and its XML parser, the removals
 * and the copy, the streamed upload and the presigned URLs.
 */
const casesNotBuiltYet: readonly string[] = [
  // The listing and everything that reads one.
  "put/accepted-keys",
  "list/",
  "flow/3-file-browser",
  "errors/bad-credentials",
  // The removals, the copy and the move.
  "delete/",
  "deleteAll/",
  "copy/",
  "move/",
  "flow/5-prefix-move",
  // A body that arrives as a stream, and the multipart upload above one part.
  "put/stream-round-trip",
  "put/multipart-round-trip",
  "put/empty-body",
  "put/abort-during-upload",
  "put/stream-consumed",
  "flow/1-large-upload",
];

const covered = (source: ConformanceCaseSource): boolean =>
  !casesNotBuiltYet.some((unbuilt) => source.name.startsWith(unbuilt));

const configured = configuredStorage();
const denied = configured === undefined ? undefined : storageWithDeniedCredentials(configured);

/** ADR 0012: a run without an endpoint fails, and one failure says why (see below). */
function endpointOrFail(): S3AdapterOptions {
  if (configured === undefined) {
    throw new Error("No S3 endpoint is configured; see `harness/s3/README.md`");
  }

  return configured;
}

const target: ConformanceTarget = {
  name: "@stowage/adapter-s3",

  createStorage() {
    return s3Storage(endpointOrFail());
  },

  createStorageWithBadCredentials() {
    return s3Storage(storageWithBadCredentials(endpointOrFail()));
  },

  // Spec 8.2 keeps the case out of a run where the target supplies no factory, which is
  // what an endpoint without the second identity of `s3.json` leaves.
  ...(denied === undefined ? {} : { createStorageWithDeniedCredentials: () => s3Storage(denied) }),

  // Spec 8.2 deletes below the prefix, which needs the `deleteAll` that arrives with the
  // removals. Until then the endpoint of ADR 0012 starts from an empty store and every
  // run writes below a prefix of its own.
  async cleanup() {},
};

// ADR 0012: `pnpm test` includes this tier and fails where no endpoint is reachable
// rather than passing with it skipped. One failure says so, in place of the same reason
// repeated over every case the run then registers none of.
test("the S3 endpoint of ADR 0012 is configured (see `harness/s3/README.md`)", () => {
  expect(configured).toBeDefined();
});

describeCases(configured === undefined ? [] : selectedCases().filter(covered), target, {
  describe,
  test,
});
