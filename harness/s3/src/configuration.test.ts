import { describe, expect, test } from "vitest";

import { endpointNameFrom } from "./configuration.ts";

describe("endpointNameFrom", () => {
  test("reads the name the endpoint was started or configured under", () => {
    expect(endpointNameFrom({ STOWAGE_S3_ENDPOINT_NAME: "seaweedfs" })).toBe("seaweedfs");
  });

  test("leaves an endpoint without a name unnamed", () => {
    expect(endpointNameFrom({ STOWAGE_S3_ENDPOINT_NAME: "" })).toBe(undefined);
  });
});
