import { isStorageError, type StorageError } from "@stowage/core";
import { expect, test } from "vitest";

import { type AzureBlobAdapterOptions, readConfiguration } from "./configuration.ts";

const credentials = { accessToken: "token" };

function options(overrides: Partial<AzureBlobAdapterOptions> = {}): AzureBlobAdapterOptions {
  return { account: "stowage", container: "conformance", credentials, ...overrides };
}

/** The `InvalidOption` a refused configuration throws, or a failure of the test itself. */
function refusal(overrides: Partial<AzureBlobAdapterOptions>): StorageError {
  try {
    readConfiguration(options(overrides));
  } catch (failure) {
    if (isStorageError(failure)) return failure;

    throw failure;
  }

  throw new Error("The configuration was accepted");
}

test("it addresses the account's blob endpoint where no endpoint is configured", () => {
  const configuration = readConfiguration(options());

  expect(configuration.protocol).toBe("https:");
  expect(configuration.host).toBe("stowage.blob.core.windows.net");
  expect(configuration.basePath).toBe("");
});

test("the path of a configured endpoint becomes the prefix of every request path", () => {
  const configuration = readConfiguration(
    options({ account: "devstoreaccount1", endpoint: "http://127.0.0.1:10000/devstoreaccount1" }),
  );

  expect(configuration.protocol).toBe("http:");
  expect(configuration.host).toBe("127.0.0.1:10000");
  expect(configuration.basePath).toBe("/devstoreaccount1");
});

test.each([
  [undefined, false],
  ["https://blob.example.com", false],
  ["https://127.0.0.1:10000/devstoreaccount1", true],
  ["http://localhost:10000", true],
  ["https://[::1]:10000", true],
])("the endpoint %s is a loopback address: %s", (endpoint, loopback) => {
  expect(readConfiguration(options({ endpoint })).loopback).toBe(loopback);
});

test("a trailing slash of the endpoint's path is no segment of its own", () => {
  const configuration = readConfiguration(options({ endpoint: "https://blob.example.com/base/" }));

  expect(configuration.basePath).toBe("/base");
});

test.each([
  ["http://127.0.0.1:10000", "127.0.0.1:10000"],
  ["http://localhost:10000", "localhost:10000"],
  ["http://[::1]:10000", "[::1]:10000"],
])("`http:` is accepted for the loopback host %s", (endpoint, host) => {
  expect(readConfiguration(options({ endpoint })).host).toBe(host);
});

test.each([
  ["http://blob.example.com", "a host that is not loopback"],
  ["ftp://127.0.0.1", "a scheme that is neither"],
  ["/devstoreaccount1", "a URL that is not absolute"],
  ["https://user:pass@blob.example.com", "userinfo"],
  ["https://blob.example.com?x=1", "a query"],
  ["https://blob.example.com#part", "a fragment"],
  ["https://blob.example.com/a%zz", "a malformed escape in its path"],
])("%s is refused as an endpoint: %s", (endpoint) => {
  const failure = refusal({ endpoint });

  expect(failure.code).toBe("InvalidOption");
  expect(failure.message).toContain("endpoint");
  expect(failure.attempts).toBe(0);
});

test("`bucket` of the refusal is the container", () => {
  expect(refusal({ endpoint: "ftp://127.0.0.1" }).bucket).toBe("conformance");
  expect(refusal({ endpoint: "ftp://127.0.0.1" }).provider).toBe("azure-blob");
});

test("an unknown key is refused by name", () => {
  // oxlint-disable-next-line no-unsafe-type-assertion -- the point of the case
  const failure = refusal({ accessTier: "Cool" } as Partial<AzureBlobAdapterOptions>);

  expect(failure.code).toBe("InvalidOption");
  expect(failure.message).toContain("accessTier");
});

test.each(["account", "container"] as const)("an empty `%s` is refused by name", (option) => {
  const failure = refusal({ [option]: "" });

  expect(failure.code).toBe("InvalidOption");
  expect(failure.message).toContain(option);
});

test.each([
  ["Stowage", "an upper-case letter"],
  ["st", "fewer than three characters"],
  ["a".repeat(25), "more than 24 characters"],
  ["evil.example/x", "characters no account name holds"],
])("the account %s is refused: %s", (account) => {
  const failure = refusal({ account });

  expect(failure.code).toBe("InvalidOption");
  expect(failure.message).toContain("account");
});

test("`credentials` is required", () => {
  const failure = refusal({ credentials: undefined });

  expect(failure.code).toBe("InvalidOption");
  expect(failure.message).toContain("credentials");
});

test("the defaults are three attempts, 8 MiB parts and four in flight", () => {
  const configuration = readConfiguration(options());

  expect(configuration.maxAttempts).toBe(3);
  expect(configuration.partSize).toBe(8 * 1024 * 1024);
  expect(configuration.concurrency).toBe(4);
});

test("`retry: false` sends one attempt", () => {
  expect(readConfiguration(options({ retry: false })).maxAttempts).toBe(1);
});

test.each([
  [{ retry: { maxAttempts: 0 } }, "maxAttempts"],
  [{ retry: { maxAttempts: 4 } }, "maxAttempts"],
  [{ retry: { maxAttempts: 1.5 } }, "maxAttempts"],
  [{ multipart: { partSize: 5 * 1024 * 1024 - 1 } }, "partSize"],
  [{ multipart: { partSize: 4000 * 1024 * 1024 + 1 } }, "partSize"],
  [{ multipart: { concurrency: 0 } }, "concurrency"],
  [{ multipart: { concurrency: 17 } }, "concurrency"],
] as const)("%j is refused rather than clamped", (overrides, option) => {
  const failure = refusal(overrides);

  expect(failure.code).toBe("InvalidOption");
  expect(failure.message).toContain(option);
});

test.each([
  [{ retry: { maxAttempts: 1 } }, "maxAttempts", 1],
  [{ multipart: { partSize: 5 * 1024 * 1024 } }, "partSize", 5 * 1024 * 1024],
  [{ multipart: { partSize: 4000 * 1024 * 1024 } }, "partSize", 4000 * 1024 * 1024],
  [{ multipart: { concurrency: 16 } }, "concurrency", 16],
] as const)("%j is taken at the edge of its range", (overrides, option, value) => {
  expect(readConfiguration(options(overrides))[option]).toBe(value);
});

test.each([
  // oxlint-disable-next-line no-unsafe-type-assertion -- the point of the case
  [{ retry: { backoff: 2 } } as Partial<AzureBlobAdapterOptions>, "backoff"],
  // oxlint-disable-next-line no-unsafe-type-assertion -- the point of the case
  [{ multipart: { blockSize: 2 } } as Partial<AzureBlobAdapterOptions>, "blockSize"],
  // oxlint-disable-next-line no-unsafe-type-assertion -- the point of the case
  [{ retry: true } as unknown as Partial<AzureBlobAdapterOptions>, "retry"],
  // oxlint-disable-next-line no-unsafe-type-assertion -- the point of the case
  [{ multipart: null } as unknown as Partial<AzureBlobAdapterOptions>, "multipart"],
])("%j is refused by name", (overrides, option) => {
  const failure = refusal(overrides);

  expect(failure.code).toBe("InvalidOption");
  expect(failure.message).toContain(option);
});
