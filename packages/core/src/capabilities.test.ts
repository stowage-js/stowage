import { expect, test } from "vitest";

import { capabilityNames } from "./capabilities.ts";

test("publishes the five names of spec 4.9 in its order", () => {
  expect(capabilityNames).toEqual([
    "keyBytesPreserved",
    "presignedUrls",
    "rangeReads",
    "userMetadata",
    "userMetadataTokenKeys",
  ]);
});
