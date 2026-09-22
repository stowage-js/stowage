import { describe, test } from "vitest";

import { s3Storage } from "../../../packages/adapter-s3/src/index.ts";
import type { ConformanceCaseSource } from "../../../packages/conformance/src/case.ts";
import { describeCases } from "../../../packages/conformance/src/describe.ts";
import { selectedCases } from "../../../packages/conformance/src/run.ts";
import type { ConformanceTarget } from "../../../packages/conformance/src/target.ts";
import { configuredStorage } from "./environment.ts";

/**
 * The operations `adapter-s3` has not been built yet, each named by the case it leaves
 * unrun. The list shrinks as they land: the listing and its XML parser, the removals
 * and the copy, the streamed upload, the presigned URLs, and the failure table the
 * error cases read.
 */
const notBuiltYet: readonly string[] = [
  // The listing and everything that reads one.
  "put/accepted-keys",
  "list/",
  "flow/3-file-browser",
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
  // The provider codes, which every error case reads through.
  "errors/",
];

const covered = (source: ConformanceCaseSource): boolean =>
  !notBuiltYet.some((unbuilt) => source.name.startsWith(unbuilt));

const configured = configuredStorage();

const target: ConformanceTarget = {
  name: "@stowage/adapter-s3",

  createStorage() {
    if (configured === undefined) {
      throw new Error("No S3 endpoint is configured; see `harness/s3/README.md`");
    }

    return s3Storage(configured);
  },

  // Spec 8.2 deletes below the prefix, which needs the `deleteAll` that arrives with the
  // removals. Until then the endpoint of ADR 0012 starts from an empty store and every
  // run writes below a prefix of its own.
  async cleanup() {},
};

// ADR 0012 wants a tier that did not run to say so rather than to pass. Without an
// endpoint every case reports itself skipped, which is what a harness has to report one
// with; the cases themselves know nothing about which server answers.
describeCases(selectedCases().filter(covered), target, {
  describe,
  test: configured === undefined ? test.skip : test,
});
