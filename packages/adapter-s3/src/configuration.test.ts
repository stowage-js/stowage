import { isStorageError, type StorageError } from "@stowage/core";
import { expect, test } from "vitest";

import { type S3AdapterOptions, readConfiguration } from "./configuration.ts";

const credentials = { accessKeyId: "AKIDEXAMPLE", secretAccessKey: "secret" };

function options(overrides: Partial<S3AdapterOptions> = {}): S3AdapterOptions {
  return { bucket: "stowage", region: "eu-central-1", credentials, ...overrides };
}

/** The `InvalidOption` a refused configuration throws, or a failure of the test itself. */
function refusal(overrides: Partial<S3AdapterOptions>): StorageError {
  try {
    readConfiguration(options(overrides));
  } catch (failure) {
    if (isStorageError(failure)) return failure;

    throw failure;
  }

  throw new Error("The configuration was accepted");
}

test("it addresses AWS S3 virtual-hosted where no endpoint is configured", () => {
  const configuration = readConfiguration(options());

  expect(configuration.protocol).toBe("https:");
  expect(configuration.host).toBe("stowage.s3.eu-central-1.amazonaws.com");
  expect(configuration.forcePathStyle).toBe(false);
});

test("a configured endpoint carries the bucket in its host", () => {
  const configuration = readConfiguration(
    options({ endpoint: "https://account.r2.cloudflarestorage.com", region: "auto" }),
  );

  expect(configuration.host).toBe("stowage.account.r2.cloudflarestorage.com");
});

test("`forcePathStyle` leaves the host alone and carries the bucket in the path", () => {
  const configuration = readConfiguration(
    options({ endpoint: "http://127.0.0.1:8333", forcePathStyle: true }),
  );

  expect(configuration.host).toBe("127.0.0.1:8333");
  expect(configuration.forcePathStyle).toBe(true);
});

test.each([
  ["http://127.0.0.1:8333", "127.0.0.1:8333"],
  ["http://localhost:9000", "localhost:9000"],
  ["http://[::1]:9000", "[::1]:9000"],
])("`http:` is accepted for the loopback host %s", (endpoint, host) => {
  expect(readConfiguration(options({ endpoint, forcePathStyle: true })).host).toBe(host);
});

test.each([
  ["http://s3.example.com", "a host that is not loopback"],
  ["ftp://127.0.0.1", "a scheme that is neither"],
  ["/bucket", "a URL that is not absolute"],
  ["https://user:pass@s3.example.com", "userinfo"],
  ["https://s3.example.com?x=1", "a query"],
  ["https://s3.example.com#part", "a fragment"],
])("%s is refused as an endpoint: %s", (endpoint) => {
  const failure = refusal({ endpoint });

  expect(failure.code).toBe("InvalidOption");
  expect(failure.message).toContain("endpoint");
  expect(failure.attempts).toBe(0);
});

test("an unknown key is refused by name", () => {
  // oxlint-disable-next-line no-unsafe-type-assertion -- the point of the case
  const failure = refusal({ storageClass: "GLACIER" } as Partial<S3AdapterOptions>);

  expect(failure.code).toBe("InvalidOption");
  expect(failure.message).toContain("storageClass");
});

test.each([
  ["bucket", { bucket: "" }],
  ["region", { region: "" }],
])("an empty `%s` is refused by name", (name, overrides) => {
  expect(refusal(overrides).message).toContain(name);
});

test("a missing credential is refused by name", () => {
  const failure = refusal({ credentials: undefined });

  expect(failure.code).toBe("InvalidOption");
  expect(failure.message).toContain("credentials");
});

test.each([0, 4, 1.5, Number.NaN])("`maxAttempts` of %s is refused and not clamped", (value) => {
  const failure = refusal({ retry: { maxAttempts: value } });

  expect(failure.code).toBe("InvalidOption");
  expect(failure.message).toContain("maxAttempts");
  expect(failure.message).not.toContain(String(value));
});

test.each([1, 2, 3])("`maxAttempts` of %i is taken as configured", (maxAttempts) => {
  expect(readConfiguration(options({ retry: { maxAttempts } })).maxAttempts).toBe(maxAttempts);
});

test("`retry: false` sends one attempt", () => {
  expect(readConfiguration(options({ retry: false })).maxAttempts).toBe(1);
});

test("three attempts is the default", () => {
  expect(readConfiguration(options()).maxAttempts).toBe(3);
});

const mebibyte = 1024 * 1024;

test.each([5 * mebibyte - 1, 5 * 1024 * mebibyte + 1, 8.5, Number.POSITIVE_INFINITY])(
  "`partSize` of %s is refused and not clamped",
  (partSize) => {
    expect(refusal({ multipart: { partSize } }).message).toContain("partSize");
  },
);

test.each([0, 17, 2.5])("`concurrency` of %s is refused and not clamped", (concurrency) => {
  expect(refusal({ multipart: { concurrency } }).message).toContain("concurrency");
});

test("the multipart defaults are 8 MiB and four parts in flight", () => {
  const configuration = readConfiguration(options());

  expect(configuration.partSize).toBe(8 * mebibyte);
  expect(configuration.concurrency).toBe(4);
});

test("an unknown key inside a group is refused by name", () => {
  // oxlint-disable-next-line no-unsafe-type-assertion -- the point of the case
  const failure = refusal({ multipart: { queueSize: 2 } as S3AdapterOptions["multipart"] });

  expect(failure.message).toContain("queueSize");
});

test("the bucket it was constructed with reaches the error it throws", () => {
  expect(refusal({ endpoint: "ftp://127.0.0.1" }).bucket).toBe("stowage");
  expect(refusal({ endpoint: "ftp://127.0.0.1" }).provider).toBe("s3");
});
