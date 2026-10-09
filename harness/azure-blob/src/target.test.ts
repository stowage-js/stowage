import { expect, test } from "vitest";

import type { ConformanceCaseSource } from "../../../packages/conformance/src/case.ts";
import { selectedCases } from "../../../packages/conformance/src/run.ts";
import type { Variables } from "../../s3/src/configuration.ts";
import { accessTokenFrom, storageOptionsFrom } from "./configuration.ts";
import { azureBlobRunCases, azureBlobTarget } from "./target.ts";

const printed = {
  STOWAGE_AZURE_BLOB_ENDPOINT_NAME: "azurite",
  STOWAGE_AZURE_BLOB_ENDPOINT: "https://127.0.0.1:10000/devstoreaccount1",
  STOWAGE_AZURE_BLOB_ACCOUNT: "devstoreaccount1",
  STOWAGE_AZURE_BLOB_CONTAINER: "stowage-conformance",
};

const scheduled = {
  STOWAGE_AZURE_BLOB_ENDPOINT_NAME: "azure-blob",
  STOWAGE_AZURE_BLOB_ACCOUNT: "stowageconformance",
  STOWAGE_AZURE_BLOB_CONTAINER: "stowage-conformance",
  STOWAGE_AZURE_BLOB_TENANT_ID: "00000000-0000-0000-0000-000000000000",
  STOWAGE_AZURE_BLOB_CLIENT_ID: "11111111-1111-1111-1111-111111111111",
  STOWAGE_AZURE_BLOB_DENIED_CLIENT_ID: "22222222-2222-2222-2222-222222222222",
  ACTIONS_ID_TOKEN_REQUEST_URL: "https://pipelines.actions.githubusercontent.com/abc/idtoken",
  ACTIONS_ID_TOKEN_REQUEST_TOKEN: "runtime-request-token",
};

function targetFor(variables: Variables): ReturnType<typeof azureBlobTarget> {
  const configured = storageOptionsFrom(variables, accessTokenFrom(variables));

  if (configured === undefined) throw new Error("Nothing is configured");

  return azureBlobTarget(configured, variables);
}

// ADR 0021: Azure has no answer that means only that a token expired.
test("no endpoint supplies an expired credential", () => {
  expect(targetFor(printed)).not.toHaveProperty("createStorageWithExpiredCredentials");
  expect(targetFor(scheduled)).not.toHaveProperty("createStorageWithExpiredCredentials");
});

// ADR 0067: the account answers a token it cannot read with the `401` that refreshes, and
// Azurite's other answer is a divergence rather than a reason to leave the case out.
test("every endpoint supplies a stale credential", () => {
  expect(targetFor(printed)).toHaveProperty("createStorageWithStaleCredentials");
  expect(targetFor(scheduled)).toHaveProperty("createStorageWithStaleCredentials");
});

// ADR 0012: the divergences of the emulator are what the real account settles, so the
// account runs every case of the suite as the suite states it (ADR 0026).
test("the real account runs the whole suite as the suite states it", () => {
  const options = { includeSlow: true };

  expect(azureBlobRunCases(options, scheduled)).toEqual(selectedCases(options));
});

function copyRoundTrip(
  sources: readonly ConformanceCaseSource[],
): ConformanceCaseSource | undefined {
  return sources.find((source) => source.name === "copy/round-trip");
}

// `divergences.ts` leaves `list/noncharacter-key` unrun against Azurite, whose `500` on its
// listing would fail the run's `cleanup` (#171).
test("Azurite runs the whole suite but its unrun case, its divergences as expected failures", () => {
  const options = { includeSlow: true };
  const asRun = azureBlobRunCases(options, printed);

  expect(asRun.map((source) => source.name)).toEqual(
    selectedCases(options)
      .map((source) => source.name)
      .filter((name) => name !== "list/noncharacter-key"),
  );
  expect(copyRoundTrip(asRun)).not.toEqual(copyRoundTrip(selectedCases(options)));
  expect(staleCredentials(asRun)).not.toEqual(staleCredentials(selectedCases(options)));
});

function staleCredentials(
  sources: readonly ConformanceCaseSource[],
): ConformanceCaseSource | undefined {
  return sources.find((source) => source.name === "errors/stale-credentials");
}
