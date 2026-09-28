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

import type { Variables } from "../../s3/src/configuration.ts";
import {
  endpointNameFrom,
  storageWithBadCredentials,
  storageWithDeniedCredentials,
} from "./configuration.ts";
import { withAzureBlobDivergences } from "./divergences.ts";

/**
 * The cases the adapter passes while its operations arrive one by one: those that need
 * `put` of held bytes and of a stream, `get`, `stat`, `exists`, `list`, `copy`, `move`,
 * `delete`, `deleteAll`, `presignGet` and `presignPut` and nothing else, including the
 * halves that expect a capability the storage does not declare. Every operation that
 * joins the adapter adds its cases here, until the list is the whole suite and goes. The
 * cases that send a copy, `presign/put` and `flow/2-presigned-put` run against Azurite as
 * divergences, and `list/noncharacter-key` stays unrun there (`divergences.ts`).
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
  "list/noncharacter-key",
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
  "errors/denied-credentials",
  "errors/not-a-storage-error",
  "presign/get",
  "presign/put",
  "presign/expires-in-bounds",
  "presign/put-rejects-type",
  "presign/put-rejects-length",
  "presign/expired-url",
  "flow/1-large-upload",
  "flow/2-presigned-put",
  "flow/3-file-browser",
  "flow/4-streaming-download",
]);

export function azureBlobCases(options: ConformanceRunOptions): readonly ConformanceCaseSource[] {
  return selectedCases(options).filter((source) => coveredCases.has(source.name));
}

/** `adapter-azure-blob` against the endpoint of ADR 0023, under an access token. */
export function azureBlobTarget(
  configured: AzureBlobAdapterOptions,
  variables: Variables,
): ConformanceTarget {
  const denied = storageWithDeniedCredentials(configured, variables);

  return {
    name: "@stowage/adapter-azure-blob",

    createStorage: () => azureBlobStorage(configured),

    createStorageWithBadCredentials: () => azureBlobStorage(storageWithBadCredentials(configured)),

    // Spec 9.2 keeps the case out of a run where the target supplies no factory, which is
    // what Azurite, checking no role, leaves (ADR 0023).
    ...(denied === undefined
      ? {}
      : { createStorageWithDeniedCredentials: () => azureBlobStorage(denied) }),
  };
}

export const endpointMissing =
  "No Azure Blob endpoint is configured; see `harness/azure-blob/README.md`";

/**
 * ADR 0023, after ADR 0012: a run includes this tier and fails where no endpoint is
 * reachable rather than passing with it skipped.
 */
export function describeAzureBlobEndpointCheck(
  framework: ConformanceFramework,
  configured: AzureBlobAdapterOptions | undefined,
): void {
  framework.test(
    "the Azure Blob endpoint of ADR 0023 is configured (see `harness/azure-blob/README.md`)",
    async () => {
      if (configured === undefined) throw new Error(endpointMissing);
    },
  );
}

/** The cases as a run against the endpoint `variables` name performs them. */
export function azureBlobRunCases(
  options: ConformanceRunOptions,
  variables: Variables,
): readonly ConformanceCaseSource[] {
  const endpointName = endpointNameFrom(variables);

  return withAzureBlobDivergences(azureBlobCases(options), endpointName);
}

/** The check above, then the cases as a run against the endpoint `variables` name. */
export function describeAzureBlob(
  framework: ConformanceFramework,
  configured: AzureBlobAdapterOptions | undefined,
  variables: Variables,
): void {
  describeAzureBlobEndpointCheck(framework, configured);

  if (configured === undefined) return;

  describeCases(
    azureBlobRunCases(framework, variables),
    azureBlobTarget(configured, variables),
    framework,
  );
}
