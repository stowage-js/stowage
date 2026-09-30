import { expect, test } from "vitest";

import { gcsEndpointFrom } from "./configuration.ts";
import { gcsCases, gcsRunCases, gcsTarget } from "./target.ts";

const printed = {
  STOWAGE_GCS_ENDPOINT_NAME: "fake-gcs-server",
  STOWAGE_GCS_ENDPOINT: "http://127.0.0.1:4443",
  STOWAGE_GCS_BUCKET: "stowage-conformance",
};

const scheduled = {
  STOWAGE_GCS_ENDPOINT_NAME: "gcs",
  STOWAGE_GCS_BUCKET: "stowage-conformance",
  STOWAGE_GCS_WORKLOAD_IDENTITY_PROVIDER:
    "projects/123456789012/locations/global/workloadIdentityPools/github-actions/providers/stowage",
  STOWAGE_GCS_SERVICE_ACCOUNT: "stowage-conformance@stowage-conformance.iam.gserviceaccount.com",
  STOWAGE_GCS_DENIED_SERVICE_ACCOUNT:
    "stowage-conformance-denied@stowage-conformance.iam.gserviceaccount.com",
  ACTIONS_ID_TOKEN_REQUEST_URL: "https://pipelines.actions.githubusercontent.com/abc/idtoken",
  ACTIONS_ID_TOKEN_REQUEST_TOKEN: "runtime-request-token",
};

function targetFor(variables: Record<string, string>): ReturnType<typeof gcsTarget> {
  const endpoint = gcsEndpointFrom(variables);

  if (endpoint === undefined) throw new Error("Nothing is configured");

  return gcsTarget(endpoint);
}

// Spec 10.2: a case whose factory the target does not supply reports itself skipped, and
// ADR 0034 has both credential cases skipped against the emulator, which checks neither.
test("against fake-gcs-server the target supplies no bad and no denied credential", () => {
  const target = targetFor(printed);

  expect(target).not.toHaveProperty("createStorageWithBadCredentials");
  expect(target).not.toHaveProperty("createStorageWithDeniedCredentials");
});

test("against the real bucket the target supplies a bad and a denied credential", () => {
  const target = targetFor(scheduled);

  expect(target).toHaveProperty("createStorageWithBadCredentials");
  expect(target).toHaveProperty("createStorageWithDeniedCredentials");
});

// ADR 0033: GCS has no answer that means only that a token expired.
test("no endpoint supplies an expired credential", () => {
  expect(targetFor(printed)).not.toHaveProperty("createStorageWithExpiredCredentials");
  expect(targetFor(scheduled)).not.toHaveProperty("createStorageWithExpiredCredentials");
});

// ADR 0043: both endpoints know the bucket by name alone, so both can be handed one no run
// created.
test.each([
  ["fake-gcs-server", printed],
  ["the real bucket", scheduled],
])("%s supplies a storage bound to a missing bucket", async (_endpoint, variables) => {
  const target = targetFor(variables);
  const missing = await target.createStorageWithMissingBucket?.();
  const configured = await target.createStorage();

  expect(missing?.bucket).toMatch(/^stowage-missing-/u);
  expect(missing?.bucket).not.toBe(configured.bucket);
});

test("the missing bucket is a new one on every call", async () => {
  const target = targetFor(printed);

  expect((await target.createStorageWithMissingBucket?.())?.bucket).not.toBe(
    (await target.createStorageWithMissingBucket?.())?.bucket,
  );
});

// ADR 0012: the divergences of the emulator are what the real bucket settles.
test("the real bucket runs the cases as the suite states them", () => {
  const options = { includeSlow: true };

  expect(gcsRunCases(options, scheduled)).toEqual(gcsCases(options));
});

test("fake-gcs-server runs the cases of its divergence list as expected failures", () => {
  const options = { includeSlow: true };
  const asRun = gcsRunCases(options, printed);
  const moveRoundTrip = (sources: typeof asRun) =>
    sources.find((source) => source.name === "move/round-trip");

  expect(asRun.map((source) => source.name)).toEqual(gcsCases(options).map((each) => each.name));
  expect(moveRoundTrip(asRun)).not.toEqual(moveRoundTrip(gcsCases(options)));
});
