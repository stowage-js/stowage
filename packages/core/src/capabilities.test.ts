import { expect, test } from "vitest";

import { capabilityNames } from "./capabilities.ts";

test("publishes the six names of spec 4.9 in its order", () => {
  expect(capabilityNames).toEqual([
    "contentHeaders",
    "keyBytesPreserved",
    "presignedUrls",
    "rangeReads",
    "userMetadata",
    "userMetadataTokenKeys",
  ]);
});
