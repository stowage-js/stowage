import { describe, expect, test } from "vitest";

import { endpointTiersFrom } from "./endpoints.ts";

describe("endpointTiersFrom", () => {
  test.each([
    ["unset", {}],
    ["empty", { STOWAGE_CONFORMANCE_ENDPOINTS: "" }],
  ])("asks for every tier where the list is %s", (_, variables) => {
    expect(endpointTiersFrom(variables)).toEqual(new Set(["s3", "azure-blob"]));
  });

  test("asks for the tiers the list names", () => {
    expect(endpointTiersFrom({ STOWAGE_CONFORMANCE_ENDPOINTS: "azure-blob" })).toEqual(
      new Set(["azure-blob"]),
    );
  });

  test("refuses a name that is no tier", () => {
    expect(() => endpointTiersFrom({ STOWAGE_CONFORMANCE_ENDPOINTS: "gcs" })).toThrow(
      '`STOWAGE_CONFORMANCE_ENDPOINTS` names "gcs", which is none of s3, azure-blob',
    );
  });

  test("asks for no tier where the list is `none`", () => {
    expect(endpointTiersFrom({ STOWAGE_CONFORMANCE_ENDPOINTS: "none" })).toEqual(new Set());
  });

  test("refuses `none` beside a tier, which asks for no tier and for one at once", () => {
    expect(() => endpointTiersFrom({ STOWAGE_CONFORMANCE_ENDPOINTS: "none,s3" })).toThrow(
      "`STOWAGE_CONFORMANCE_ENDPOINTS` names `none` beside a tier, and `none` stands alone",
    );
  });
});
