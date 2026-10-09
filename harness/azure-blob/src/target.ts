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
  storageWithMissingContainer,
  storageWithStaleCredentials,
} from "./configuration.ts";
import { withAzureBlobDivergences } from "./divergences.ts";

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

    createStorageWithMissingBucket: () => azureBlobStorage(storageWithMissingContainer(configured)),

    createStorageWithStaleCredentials: (onRefresh) =>
      azureBlobStorage(storageWithStaleCredentials(configured, onRefresh)),

    // Spec 14.2 keeps the case out of a run where the target supplies no factory, which is
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

  return withAzureBlobDivergences(selectedCases(options), endpointName);
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
