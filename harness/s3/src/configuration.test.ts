import { describe, expect, test } from "vitest";

import type { S3AdapterOptions } from "../../../packages/adapter-s3/src/index.ts";
import {
  endpointNameFrom,
  storageWithDeniedCredentials,
  storageWithExpiredCredentials,
} from "./configuration.ts";

const configured: S3AdapterOptions = {
  bucket: "stowage-conformance",
  region: "us-east-1",
  endpoint: "https://s3.us-east-1.amazonaws.com",
  credentials: { accessKeyId: "long-lived", secretAccessKey: "long-lived-secret" },
};

const expiredToken = {
  STOWAGE_S3_EXPIRED_ACCESS_KEY_ID: "ASIA-SESSION",
  STOWAGE_S3_EXPIRED_SECRET_ACCESS_KEY: "session-secret",
  STOWAGE_S3_EXPIRED_SESSION_TOKEN: "session-token",
  STOWAGE_S3_EXPIRED_AT: "2026-09-24T06:15:00+00:00",
};

describe("storageWithExpiredCredentials", () => {
  test("signs with the session token STS handed out, and says when it expires", () => {
    expect(storageWithExpiredCredentials(configured, expiredToken)).toEqual({
      options: {
        ...configured,
        credentials: {
          accessKeyId: "ASIA-SESSION",
          secretAccessKey: "session-secret",
          sessionToken: "session-token",
        },
      },
      expiresAt: new Date("2026-09-24T06:15:00Z"),
    });
  });

  test.each(Object.keys(expiredToken))("supplies nothing without %s", (name) => {
    expect(storageWithExpiredCredentials(configured, { ...expiredToken, [name]: "" })).toBe(
      undefined,
    );
  });

  // `workerd` hands a binding whose variable is unset over as `null`.
  test("supplies nothing where the bindings are unset", () => {
    expect(
      storageWithExpiredCredentials(
        configured,
        Object.fromEntries(Object.keys(expiredToken).map((name) => [name, null])),
      ),
    ).toBe(undefined);
  });

  test("refuses an expiration that is no time", () => {
    expect(() =>
      storageWithExpiredCredentials(configured, { ...expiredToken, STOWAGE_S3_EXPIRED_AT: "soon" }),
    ).toThrow("STOWAGE_S3_EXPIRED_AT");
  });
});

describe("endpointNameFrom", () => {
  test("reads the name the endpoint was started or configured under", () => {
    expect(endpointNameFrom({ STOWAGE_S3_ENDPOINT_NAME: "seaweedfs" })).toBe("seaweedfs");
  });

  test("leaves an endpoint without a name unnamed", () => {
    expect(endpointNameFrom({ STOWAGE_S3_ENDPOINT_NAME: "" })).toBe(undefined);
  });
});

describe("storageWithDeniedCredentials", () => {
  test("supplies nothing where the bindings are unset", () => {
    expect(
      storageWithDeniedCredentials(configured, {
        STOWAGE_S3_DENIED_ACCESS_KEY_ID: null,
        STOWAGE_S3_DENIED_SECRET_ACCESS_KEY: null,
      }),
    ).toBe(undefined);
  });
});
