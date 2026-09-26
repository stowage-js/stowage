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

/**
 * The cases the adapter passes while its operations arrive one by one: those that need
 * `put` of held bytes, `get`, `stat`, `exists` and `list` and nothing else, including the
 * halves that expect a capability the storage does not declare yet, and those that meet
 * `copy` only with what it refuses before a request. Every operation that joins the
 * adapter adds its cases here, until the list is the whole suite and goes.
 * `list/noncharacter-key` waits for `delete`, which ends it.
 */
const coveredCases: ReadonlySet<string> = new Set([
  "declaration/valid-names",
  "declaration/identity",
  "put/string-round-trip",
  "put/overwrites",
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
  "errors/shape",
  "errors/bad-credentials",
  "errors/not-a-storage-error",
  "presign/get",
  "presign/put",
  "presign/expires-in-bounds",
  "presign/put-rejects-type",
  "presign/put-rejects-length",
  "presign/expired-url",
  "flow/3-file-browser",
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

    // The default of spec 9.2 deletes below the prefix through `deleteAll`, which the
    // adapter does not have yet. Azurite holds the run in memory and is recreated by every
    // start, so nothing the run wrote outlives it.
    async cleanup() {},
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
): void {
  framework.test(
    "the Azure Blob endpoint of ADR 0023 is configured (see `harness/azure-blob/README.md`)",
    async () => {
      if (configured === undefined) throw new Error(endpointMissing);
    },
  );

  if (configured === undefined) return;

  describeCases(azureBlobCases(framework), azureBlobTarget(configured), framework);
}
