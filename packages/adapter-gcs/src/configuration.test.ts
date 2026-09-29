import { isStorageError, type StorageError } from "@stowage/core";
import { expect, test } from "vitest";

import { type GcsAdapterOptions, readConfiguration } from "./configuration.ts";

const credentials = { accessToken: "token" };

function options(overrides: Partial<GcsAdapterOptions> = {}): GcsAdapterOptions {
  return { bucket: "conformance", credentials, ...overrides };
}

/** The `InvalidOption` a refused configuration throws, or a failure of the test itself. */
function refusal(overrides: Record<string, unknown>): StorageError {
  try {
    readConfiguration(options(overrides));
  } catch (failure) {
    if (isStorageError(failure)) return failure;

    throw failure;
  }

  throw new Error("The configuration was accepted");
}

/** The `InvalidOption` spec 9.1 has a refused configuration throw, naming `option`. */
function refusedNaming(option: string) {
  return expect.objectContaining({
    code: "InvalidOption",
    message: expect.stringContaining(`\`${option}\``),
    operation: "gcsStorage",
    provider: "gcs",
    attempts: 0,
  });
}

test("it addresses the public endpoint where no endpoint is configured", () => {
  const configuration = readConfiguration(options());

  expect(configuration.origin).toBe("https://storage.googleapis.com");
  expect(configuration.basePath).toBe("");
});

test("the path of a configured endpoint becomes the prefix of every request path", () => {
  const configuration = readConfiguration(options({ endpoint: "https://gcs.example.com/base/" }));

  expect(configuration.origin).toBe("https://gcs.example.com");
  expect(configuration.basePath).toBe("/base");
});

test("the path of the endpoint is held as it stands before encoding", () => {
  const configuration = readConfiguration(
    options({ endpoint: "https://gcs.example.com/a%20b/gr%C3%BC%C3%9Fe" }),
  );

  expect(configuration.basePath).toBe("/a b/grüße");
});

test.each([
  ["http://127.0.0.1:4443", "http://127.0.0.1:4443"],
  ["http://localhost:4443", "http://localhost:4443"],
  ["http://[::1]:4443", "http://[::1]:4443"],
])("`http:` is accepted for the loopback host of %s", (endpoint, origin) => {
  expect(readConfiguration(options({ endpoint })).origin).toBe(origin);
});

test.each([
  ["http://gcs.example.com", "a host that is not loopback"],
  ["ftp://127.0.0.1", "a scheme that is neither"],
  ["/storage/v1", "a URL that is not absolute"],
  ["https://user:pass@gcs.example.com", "userinfo"],
  ["https://gcs.example.com?x=1", "a query"],
  ["https://gcs.example.com#part", "a fragment"],
  ["https://gcs.example.com/a%zz", "a malformed escape in its path"],
])("%s is refused as an endpoint: %s", (endpoint) => {
  expect(refusal({ endpoint })).toEqual(refusedNaming("endpoint"));
});

test("an endpoint that is no string is refused", () => {
  expect(refusal({ endpoint: 4443 })).toEqual(refusedNaming("endpoint"));
});

test.each([
  ["project", "stowage-conformance"],
  ["region", "europe-north2"],
  ["forcePathStyle", true],
])("the unknown key `%s` is refused and named", (key, value) => {
  expect(refusal({ [key]: value })).toEqual(refusedNaming(key));
});

test.each([[""], [undefined], [42]])("the bucket %j is refused", (bucket) => {
  expect(refusal({ bucket })).toEqual(refusedNaming("bucket"));
});

test("a configuration without credentials is refused", () => {
  expect(refusal({ credentials: undefined })).toEqual(refusedNaming("credentials"));
});

test("a resolver is taken as the credentials, and not called at construction", () => {
  let called = false;
  const configuration = readConfiguration(
    options({
      credentials: () => {
        called = true;

        return credentials;
      },
    }),
  );

  expect(typeof configuration.credentials).toBe("function");
  expect(called).toBe(false);
});

test("three attempts and parts of 8 MiB where nothing is configured", () => {
  const configuration = readConfiguration(options());

  expect(configuration.maxAttempts).toBe(3);
  expect(configuration.partSize).toBe(8 * 1024 * 1024);
});

test.each<[GcsAdapterOptions["retry"], number]>([
  [false, 1],
  [{}, 3],
  [{ maxAttempts: 1 }, 1],
  [{ maxAttempts: 3 }, 3],
])("`retry: %j` makes %i attempts", (retry, attempts) => {
  expect(readConfiguration(options({ retry })).maxAttempts).toBe(attempts);
});

test.each([[0], [4], [2.5], [Number.NaN], ["3"]])(
  "`maxAttempts: %j` is refused, not clamped",
  (maxAttempts) => {
    expect(refusal({ retry: { maxAttempts } })).toEqual(refusedNaming("maxAttempts"));
  },
);

test.each([[true], [null], ["3"]])("`retry: %j` is no group of options", (retry) => {
  expect(refusal({ retry })).toEqual(refusedNaming("retry"));
});

test("an unknown key in `retry` is refused and named", () => {
  expect(refusal({ retry: { maxDelay: 5000 } })).toEqual(refusedNaming("maxDelay"));
});

const kibibyte = 1024;
const gibibyte = 1024 * 1024 * 1024;

test.each([[256 * kibibyte], [768 * kibibyte], [16 * 1024 * kibibyte], [5 * gibibyte]])(
  "`partSize: %i` is a multiple of 256 KiB within the range and taken as it is",
  (partSize) => {
    expect(readConfiguration(options({ multipart: { partSize } })).partSize).toBe(partSize);
  },
);

test.each([
  [0, "no part at all"],
  [128 * kibibyte, "below 256 KiB"],
  [5 * 1024 * 1024 + 1, "no multiple of 256 KiB"],
  [1000 * 1000, "a decimal megabyte, which is no multiple of 256 KiB"],
  [5 * gibibyte + 256 * kibibyte, "above 5 GiB"],
  [Number.NaN, "no number"],
])("`partSize: %d` is refused, not clamped: %s", (partSize) => {
  expect(refusal({ multipart: { partSize } })).toEqual(refusedNaming("partSize"));
});

test("there is no `concurrency`: resumable chunks go one after another", () => {
  expect(refusal({ multipart: { concurrency: 4 } })).toEqual(refusedNaming("concurrency"));
});

test.each([[true], [null]])("`multipart: %j` is no group of options", (multipart) => {
  expect(refusal({ multipart })).toEqual(refusedNaming("multipart"));
});

const serviceAccount = "stowage-conformance@stowage-conformance.iam.gserviceaccount.com";

test("no signer is held where none is configured", () => {
  expect(readConfiguration(options()).signer).toBeUndefined();
});

test.each([
  ["a private key", { serviceAccount, privateKey: "-----BEGIN PRIVATE KEY-----" }],
  ["a resolver of a private key", { serviceAccount, privateKey: () => "a key" }],
  ["a token of its own", { serviceAccount, credentials }],
  ["a resolver of a token of its own", { serviceAccount, credentials: () => credentials }],
])("a signer holding %s is taken as it is", (_, signer) => {
  expect(readConfiguration(options({ signer })).signer).toBe(signer);
});

test.each([
  ["a signer that is no object", "a service account", "signer"],
  ["a signer that is null", null, "signer"],
  ["no service account", { privateKey: "a key" }, "signer.serviceAccount"],
  [
    "an empty service account",
    { serviceAccount: "", privateKey: "a key" },
    "signer.serviceAccount",
  ],
  [
    "a service account that is no string",
    { serviceAccount: 1, credentials },
    "signer.serviceAccount",
  ],
  ["neither a key nor a token", { serviceAccount }, "signer"],
  ["both a key and a token", { serviceAccount, privateKey: "a key", credentials }, "signer"],
  ["an empty private key", { serviceAccount, privateKey: "" }, "signer.privateKey"],
  ["a private key that is null", { serviceAccount, privateKey: null }, "signer.privateKey"],
  ["a token that is null", { serviceAccount, credentials: null }, "signer.credentials"],
  ["a private key that is no key", { serviceAccount, privateKey: 5 }, "signer.privateKey"],
  ["a token that is an empty string", { serviceAccount, credentials: "" }, "signer.credentials"],
  ["a token that is a bare string", { serviceAccount, credentials: "ya29" }, "signer.credentials"],
  ["an unknown field", { serviceAccount, privateKey: "a key", keyId: "1" }, "signer.keyId"],
])("a signer holding %s is refused", (_, signer, naming) => {
  expect(refusal({ signer })).toEqual(refusedNaming(naming));
});

test("a refusal names the key and never the value it refused", () => {
  const failure = refusal({ signer: { serviceAccount, privateKey: "a key", secret: "hunter2" } });

  expect(failure.message).not.toContain("hunter2");
});
