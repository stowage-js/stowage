import type { AzureBlobAdapterOptions } from "../../../packages/adapter-azure-blob/src/index.ts";
import { azureBlobStorage } from "../../../packages/adapter-azure-blob/src/index.ts";
import type { ConformanceCaseSource } from "../../../packages/conformance/src/case.ts";
import {
  type ConformanceFramework,
  describeCases,
} from "../../../packages/conformance/src/describe.ts";
import {
  type ConformanceRunOptions,
  selectedCases,
} from "../../../packages/conformance/src/run.ts";
import type { ConformanceTarget } from "../../../packages/conformance/src/target.ts";

import { storageWithBadCredentials } from "./configuration.ts";
import { withAzureBlobDivergences } from "./divergences.ts";

/**
 * The cases the adapter passes while its operations arrive one by one: those that need
 * `put` of held bytes and of a stream, `get`, `stat`, `exists`, `list`, `copy`, `move`,
 * `delete` and `deleteAll` and nothing else, including the halves that expect a capability
 * the storage does not declare yet. Every operation that joins the adapter adds its cases
 * here, until the list is the whole suite and goes. The cases that send a copy run against
 * Azurite as divergences (`divergences.ts`).
 * `list/noncharacter-key` waits for an Azurite that lists a name holding `U+FFFE` (#171):
 * the pinned one answers that `List Blobs` with `500`, and the blob the case leaves behind
 * fails the `cleanup` of the run with the same answer.
 */
const coveredCases: ReadonlySet<string> = new Set([
  "declaration/valid-names",
  "declaration/identity",
  "put/string-round-trip",
  "put/stream-round-trip",
  "put/multipart-round-trip",
  "put/empty-body",
  "put/abort-during-upload",
  "put/stream-consumed",
  "put/concurrent-writers",
  "put/overwrites",
  "put/user-metadata",
  "put/user-metadata-limits",
  "put/user-metadata-token-keys",
  "get/missing-key",
  "get/stream",
  "get/text-and-json",
  "get/body-read-once",
  "get/stat-from-response",
  "get/addressable-keys",
  "get/aborted-signal",
  "get/range",
  "get/range-unsatisfiable",
  "get/range-clipped",
  "stat/describes-object",
  "stat/missing-key",
  "exists/answers",
  "exists/invalid-key",
  "list/nothing",
  "list/every-object-once",
  "list/entry-shape",
  "list/pages-and-cursor",
  "list/delimiter",
  "list/prefix-mid-segment",
  "list/lazy",
  "list/page-size-bounds",
  "list/invalid-cursor",
  "list/invalid-delimiter",
  "list/past-one-thousand",
  "list/key-bytes",
  "copy/round-trip",
  "copy/overwrites",
  "copy/missing-source",
  "copy/onto-itself",
  "copy/invalid-keys",
  "copy/user-metadata",
  "move/round-trip",
  "move/missing-source",
  "delete/single",
  "delete/many",
  "delete/absent-key-succeeds",
  "delete/nothing",
  "delete/invalid-key-reported",
  "delete/past-one-thousand",
  "deleteAll/below-prefix",
  "deleteAll/nothing",
  "deleteAll/past-one-thousand",
  "errors/shape",
  "errors/bad-credentials",
  "errors/not-a-storage-error",
  "presign/get",
  "presign/put",
  "presign/expires-in-bounds",
  "presign/put-rejects-type",
  "presign/put-rejects-length",
  "presign/expired-url",
  "flow/1-large-upload",
  "flow/3-file-browser",
  "flow/4-streaming-download",
]);

export function azureBlobCases(options: ConformanceRunOptions): readonly ConformanceCaseSource[] {
  return selectedCases(options).filter((source) => coveredCases.has(source.name));
}

/** `adapter-azure-blob` against the endpoint of ADR 0023, under an access token. */
export function azureBlobTarget(configured: AzureBlobAdapterOptions): ConformanceTarget {
  return {
    name: "@stowage/adapter-azure-blob",

    createStorage: () => azureBlobStorage(configured),

    createStorageWithBadCredentials: () => azureBlobStorage(storageWithBadCredentials(configured)),
  };
}

export const endpointMissing =
  "No Azure Blob endpoint is configured; see `harness/azure-blob/README.md`";

/**
 * ADR 0023, after ADR 0012: a run includes this tier and fails where no endpoint is
 * reachable rather than passing with it skipped.
 */
export function describeAzureBlob(
  framework: ConformanceFramework,
  configured: AzureBlobAdapterOptions | undefined,
  endpointName: string | undefined,
): void {
  framework.test(
    "the Azure Blob endpoint of ADR 0023 is configured (see `harness/azure-blob/README.md`)",
    async () => {
      if (configured === undefined) throw new Error(endpointMissing);
    },
  );

  if (configured === undefined) return;

  describeCases(
    withAzureBlobDivergences(azureBlobCases(framework), endpointName),
    azureBlobTarget(configured),
    framework,
  );
}
