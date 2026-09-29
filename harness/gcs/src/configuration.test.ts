import { expect, test } from "vitest";

import { storageOptionsFrom } from "./configuration.ts";

const printed = {
  STOWAGE_GCS_ENDPOINT: "http://127.0.0.1:4443",
  STOWAGE_GCS_BUCKET: "stowage-conformance",
};

test("the storage is constructed against what `start.sh` printed", () => {
  expect(storageOptionsFrom(printed)).toEqual({
    bucket: "stowage-conformance",
    endpoint: "http://127.0.0.1:4443",
    credentials: { accessToken: "fake-gcs-server" },
  });
});

test.each([
  ["no endpoint", { ...printed, STOWAGE_GCS_ENDPOINT: undefined }],
  ["an empty endpoint", { ...printed, STOWAGE_GCS_ENDPOINT: "" }],
  ["no bucket", { ...printed, STOWAGE_GCS_BUCKET: undefined }],
  ["a bucket a `workerd` binding left unset", { ...printed, STOWAGE_GCS_BUCKET: null }],
])("nothing is configured with %s", (_, variables) => {
  expect(storageOptionsFrom(variables)).toBeUndefined();
});
