import { isStorageError, type ResolverOptions, type StorageError } from "@stowage/core";
import { afterEach, beforeEach, expect, expectTypeOf, test, vi } from "vitest";

import {
  type GcsAdapterOptions,
  type GcsCredentials,
  type GcsSigner,
  type GcsSigningStorage,
  type GcsStorage,
  gcsStorage,
} from "./index.ts";

const now = new Date("2026-09-29T08:00:00Z");

beforeEach(() => {
  vi.useFakeTimers({ now, toFake: ["Date"] });
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

interface SentRequest {
  readonly url: string;
  readonly method: string;
  readonly headers: Headers;
  readonly body: string;
}

/** What `fetch` was called with, in order, while it answered `answer`. */
function stubFetch(answer: (request: SentRequest) => Response | Promise<Response>): SentRequest[] {
  const sent: SentRequest[] = [];

  vi.stubGlobal("fetch", async (url: string, init: RequestInit): Promise<Response> => {
    const request: SentRequest = {
      url,
      method: init.method ?? "GET",
      headers: new Headers(init.headers),
      body: await new Response(init.body).text(),
    };

    sent.push(request);

    return await answer(request);
  });

  return sent;
}

/** Spec 9.9 has a local key sign without a request, so any `fetch` fails the test. */
function refuseFetch(): void {
  vi.stubGlobal("fetch", () => {
    throw new Error("A URL signed with a local key sent a request");
  });
}

const serviceAccount = "stowage-conformance@stowage-conformance.iam.gserviceaccount.com";
const accessToken = "ya29.storage";
const signerToken = "ya29.signer";

const keyPair = await crypto.subtle.generateKey(
  {
    name: "RSASSA-PKCS1-v1_5",
    modulusLength: 2048,
    publicExponent: new Uint8Array([1, 0, 1]),
    hash: "SHA-256",
  },
  true,
  ["sign", "verify"],
);

const pem = await pemOf(keyPair.privateKey);

async function pemOf(key: CryptoKey): Promise<string> {
  const der = new Uint8Array(await crypto.subtle.exportKey("pkcs8", key));
  const base64 = btoa(String.fromCharCode(...der));

  return `-----BEGIN PRIVATE KEY-----\n${base64.replace(/.{64}/gu, "$&\n")}\n-----END PRIVATE KEY-----\n`;
}

function options(overrides: Partial<GcsAdapterOptions> = {}): GcsAdapterOptions {
  return { bucket: "conformance", credentials: { accessToken }, ...overrides };
}

function keySigningStorage(
  privateKey: Extract<GcsSigner, { privateKey: unknown }>["privateKey"],
  overrides: Partial<GcsAdapterOptions> = {},
): GcsSigningStorage {
  return gcsStorage({ ...options(overrides), signer: { serviceAccount, privateKey } });
}

function iamSigningStorage(
  credentials: Extract<GcsSigner, { credentials: unknown }>["credentials"],
  overrides: Partial<GcsAdapterOptions> = {},
): GcsSigningStorage {
  return gcsStorage({ ...options(overrides), signer: { serviceAccount, credentials } });
}

async function failureOf(operation: () => Promise<unknown>): Promise<StorageError> {
  const failure = await operation().then(
    () => undefined,
    (reason: unknown) => reason,
  );

  if (isStorageError(failure)) return failure;

  throw new Error(`The operation did not fail with a StorageError: ${String(failure)}`);
}

/** A value as a caller outside TypeScript may hand it over, where the types refuse it. */
function untyped(value: unknown): never {
  // oxlint-disable-next-line no-unsafe-type-assertion -- a caller outside TypeScript
  return value as never;
}

/** The query of the URL by name, which the tests read rather than the order it came in. */
function queryOf(url: string): Record<string, string> {
  return Object.fromEntries(new URL(url).searchParams);
}

/** The part of the URL before its query, as written rather than as `URL` would normalize it. */
function addressOf(url: string): string {
  return url.slice(0, url.indexOf("?"));
}

const putOptions = { expiresIn: 300, contentType: "text/plain", contentLength: 12 };

function signedBlob(signature: Uint8Array): Response {
  return Response.json({
    keyId: "0123456789abcdef",
    signedBlob: btoa(String.fromCharCode(...signature)),
  });
}

function refusedToken(): Response {
  return Response.json(
    { error: { code: 401, message: "Request had invalid authentication credentials." } },
    {
      status: 401,
      headers: {
        "www-authenticate": 'Bearer realm="https://accounts.google.com/", error="invalid_token"',
      },
    },
  );
}

// The type follows the option

test("the overloads return the signing storage for a signer and the plain one without", () => {
  const signer: GcsSigner = { serviceAccount, privateKey: pem };
  const maybeSigner = signer as GcsSigner | undefined;

  expectTypeOf(gcsStorage({ ...options(), signer })).toEqualTypeOf<GcsSigningStorage>();
  expectTypeOf(gcsStorage(options())).toEqualTypeOf<GcsStorage>();
  // ADR 0035: a signer that may be absent gets the narrower type, the safe direction.
  expectTypeOf(gcsStorage({ ...options(), signer: maybeSigner })).toEqualTypeOf<GcsStorage>();
  expectTypeOf<GcsStorage>().not.toHaveProperty("presignGet");
  expectTypeOf<GcsStorage>().not.toHaveProperty("presignPut");
});

// The URL

test("`presignGet` signs a path-style `GET` of the key at the moment of signing", async () => {
  refuseFetch();

  const url = await keySigningStorage(pem).presignGet("folder/object.txt", { expiresIn: 300 });

  expect(addressOf(url)).toBe("https://storage.googleapis.com/conformance/folder/object.txt");
  expect(queryOf(url)).toEqual({
    "X-Goog-Algorithm": "GOOG4-RSA-SHA256",
    "X-Goog-Credential": `${serviceAccount}/20260929/auto/storage/goog4_request`,
    "X-Goog-Date": "20260929T080000Z",
    "X-Goog-Expires": "300",
    "X-Goog-SignedHeaders": "host",
    "X-Goog-Signature": expect.stringMatching(/^[\da-f]{512}$/u),
  });
});

test("the signature verifies under the public half of the key", async () => {
  refuseFetch();

  const url = await keySigningStorage(pem).presignGet("object", { expiresIn: 60 });
  const query = queryOf(url);
  const signature = Uint8Array.from(query["X-Goog-Signature"]?.match(/../gu) ?? [], (pair) =>
    Number.parseInt(pair, 16),
  );
  const canonicalQuery = url.slice(url.indexOf("?") + 1, url.indexOf("&X-Goog-Signature="));
  const canonicalRequest = `GET\n/conformance/object\n${canonicalQuery}\nhost:storage.googleapis.com\n\nhost\nUNSIGNED-PAYLOAD`;
  const digest = new Uint8Array(
    await crypto.subtle.digest("SHA-256", new TextEncoder().encode(canonicalRequest)),
  );
  const stringToSign = `GOOG4-RSA-SHA256\n20260929T080000Z\n20260929/auto/storage/goog4_request\n${hex(digest)}`;

  await expect(
    crypto.subtle.verify(
      "RSASSA-PKCS1-v1_5",
      keyPair.publicKey,
      signature,
      new TextEncoder().encode(stringToSign),
    ),
  ).resolves.toBe(true);
});

function hex(bytes: Uint8Array): string {
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
}

test("the key is encoded segment by segment", async () => {
  refuseFetch();

  const url = await keySigningStorage(pem).presignGet("a b/c#d?e+f%/é", { expiresIn: 300 });

  expect(addressOf(url)).toBe(
    "https://storage.googleapis.com/conformance/a%20b/c%23d%3Fe%2Bf%25/%C3%A9",
  );
});

test("the URL is on the endpoint's scheme and host, with its path kept", async () => {
  refuseFetch();

  const url = await keySigningStorage(pem, {
    endpoint: "http://127.0.0.1:4443/some prefix",
  }).presignGet("object", { expiresIn: 300 });

  expect(addressOf(url)).toBe("http://127.0.0.1:4443/some%20prefix/conformance/object");
});

test("`presignGet` sends the two response overrides as query parameters", async () => {
  refuseFetch();

  const url = await keySigningStorage(pem).presignGet("object", {
    expiresIn: 300,
    responseContentType: "application/json",
    responseContentDisposition: "attachment; filename*=UTF-8''r%C3%A9sum%C3%A9.txt",
  });

  expect(queryOf(url)).toMatchObject({
    "response-content-type": "application/json",
    "response-content-disposition": "attachment; filename*=UTF-8''r%C3%A9sum%C3%A9.txt",
  });
});

test("`presignPut` signs a `PUT` binding length, type and host, and hands back the type", async () => {
  refuseFetch();

  const presigned = await keySigningStorage(pem).presignPut("folder/object.txt", putOptions);

  expect(addressOf(presigned.url)).toBe(
    "https://storage.googleapis.com/conformance/folder/object.txt",
  );
  expect(queryOf(presigned.url)).toMatchObject({
    "X-Goog-SignedHeaders": "content-length;content-type;host",
    "X-Goog-Expires": "300",
  });
  expect(presigned.headers).toEqual({ "content-type": "text/plain" });
});

// What is refused before signing

test.each([
  ["zero seconds", 0],
  ["a second past the week", 604_801],
  ["a fraction", 1.5],
  ["a string", "300"],
  ["nothing", undefined],
])("`expiresIn` of %s is refused on both methods", async (_, expiresIn) => {
  refuseFetch();

  const storage = keySigningStorage(pem);
  const refusals = [
    await failureOf(async () => await storage.presignGet("object", untyped({ expiresIn }))),
    await failureOf(
      async () => await storage.presignPut("object", untyped({ ...putOptions, expiresIn })),
    ),
  ];

  for (const refusal of refusals) {
    expect(refusal).toMatchObject({ code: "InvalidOption", attempts: 0 });
    expect(refusal.message).toContain("`expiresIn`");
  }
});

test("the two bounds of `expiresIn` are signed", async () => {
  refuseFetch();

  const storage = keySigningStorage(pem);

  expect(queryOf(await storage.presignGet("object", { expiresIn: 1 }))["X-Goog-Expires"]).toBe("1");
  expect(
    queryOf((await storage.presignPut("object", { ...putOptions, expiresIn: 604_800 })).url)[
      "X-Goog-Expires"
    ],
  ).toBe("604800");
});

test.each([
  ["a negative length", -1],
  ["a fraction", 1.5],
  ["NaN", Number.NaN],
  ["infinity", Number.POSITIVE_INFINITY],
  ["a string", "12"],
])("`contentLength` of %s is refused", async (_, contentLength) => {
  refuseFetch();

  const refusal = await failureOf(
    async () =>
      await keySigningStorage(pem).presignPut("object", untyped({ ...putOptions, contentLength })),
  );

  expect(refusal).toMatchObject({ code: "InvalidOption", operation: "presignPut", attempts: 0 });
  expect(refusal.message).toContain("`contentLength`");
});

test("a `contentLength` of zero is signed as the digit", async () => {
  refuseFetch();

  const presigned = await keySigningStorage(pem).presignPut("object", {
    ...putOptions,
    contentLength: 0,
  });

  expect(presigned.url).toContain("X-Goog-SignedHeaders=content-length%3Bcontent-type%3Bhost");
});

test("an empty `contentType` is refused", async () => {
  refuseFetch();

  const refusal = await failureOf(
    async () =>
      await keySigningStorage(pem).presignPut("object", { ...putOptions, contentType: "" }),
  );

  expect(refusal).toMatchObject({ code: "InvalidOption" });
  expect(refusal.message).toContain("`contentType`");
});

test("an override spec 9.9 leaves off the type is an unknown option", async () => {
  refuseFetch();

  const refusal = await failureOf(
    async () =>
      await keySigningStorage(pem).presignGet(
        "object",
        untyped({ expiresIn: 300, responseCacheControl: "no-store" }),
      ),
  );

  expect(refusal).toMatchObject({ code: "InvalidOption", operation: "presignGet" });
  expect(refusal.message).toContain("`responseCacheControl`");
});

test.each([
  ["presignGet", ""],
  ["presignPut", ""],
  ["presignPut", ".well-known/acme-challenge/token"],
  ["presignPut", "a￾b"],
])("`%s` refuses the key %j with `InvalidKey`", async (method, key) => {
  refuseFetch();

  const storage = keySigningStorage(pem);
  const refusal = await failureOf(async () =>
    method === "presignGet"
      ? await storage.presignGet(key, { expiresIn: 300 })
      : await storage.presignPut(key, putOptions),
  );

  expect(refusal).toMatchObject({ code: "InvalidKey", operation: method, attempts: 0 });
});

test("`presignGet` signs a key GCS refuses to store, which another tool may have written", async () => {
  refuseFetch();

  const url = await keySigningStorage(pem).presignGet(".well-known/acme-challenge/token", {
    expiresIn: 300,
  });

  expect(addressOf(url)).toContain("/conformance/.well-known/acme-challenge/token");
});

// The local key

test("the key is resolved on every call and never cached", async () => {
  refuseFetch();

  const resolver = vi.fn<() => string>(() => pem);
  const storage = keySigningStorage(resolver);

  await storage.presignGet("object", { expiresIn: 300 });
  await storage.presignPut("object", putOptions);

  expect(resolver.mock.calls).toEqual([[{ forceRefresh: false }], [{ forceRefresh: false }]]);
});

test("a `CryptoKey` able to sign signs as the PEM does", async () => {
  refuseFetch();

  const fromKey = await keySigningStorage(keyPair.privateKey).presignGet("object", {
    expiresIn: 300,
  });
  const fromPem = await keySigningStorage(pem).presignGet("object", { expiresIn: 300 });

  expect(fromKey).toBe(fromPem);
});

const hmacKey = await crypto.subtle.generateKey({ name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
const pssKey = await crypto.subtle.generateKey(
  {
    name: "RSA-PSS",
    modulusLength: 2048,
    publicExponent: new Uint8Array([1, 0, 1]),
    hash: "SHA-256",
  },
  false,
  ["sign", "verify"],
);

test.each([
  ["no PEM", "a private key"],
  ["a PKCS#1 PEM", pem.replaceAll("PRIVATE KEY", "RSA PRIVATE KEY")],
  ["a PEM whose body is no key", "-----BEGIN PRIVATE KEY-----\nAAAA\n-----END PRIVATE KEY-----"],
  ["a PEM whose body is no base64", "-----BEGIN PRIVATE KEY-----\n!!\n-----END PRIVATE KEY-----"],
  ["the public half", keyPair.publicKey],
  ["an HMAC key", hmacKey],
  ["an RSA-PSS key", pssKey.privateKey],
  ["a number from a resolver", () => 5],
])("a `privateKey` that is %s is `InvalidCredentials` naming it", async (_, privateKey) => {
  refuseFetch();

  const refusal = await failureOf(
    async () =>
      await keySigningStorage(untyped(privateKey)).presignGet("object", { expiresIn: 300 }),
  );

  expect(refusal).toMatchObject({
    code: "InvalidCredentials",
    operation: "presignGet",
    key: "object",
    bucket: "conformance",
    attempts: 0,
  });
  expect(refusal.message).toContain("`privateKey`");
});

// `signBlob`

test("`signBlob` signs the string to sign as the service account under the signer's token", async () => {
  const signature = new Uint8Array(256).fill(0xab);
  const sent = stubFetch(() => signedBlob(signature));

  const url = await iamSigningStorage({ accessToken: signerToken }).presignGet("object", {
    expiresIn: 300,
  });

  expect(sent).toHaveLength(1);
  expect(sent[0]).toMatchObject({
    method: "POST",
    url: `https://iamcredentials.googleapis.com/v1/projects/-/serviceAccounts/${serviceAccount}:signBlob`,
  });
  expect(sent[0]?.headers.get("authorization")).toBe(`Bearer ${signerToken}`);
  expect(sent[0]?.headers.get("content-type")).toBe("application/json");

  const payload: unknown = Reflect.get(JSON.parse(sent[0]?.body ?? "{}"), "payload");

  expect(typeof payload).toBe("string");

  const stringToSign = atob(String(payload));

  expect(stringToSign).toMatch(
    /^GOOG4-RSA-SHA256\n20260929T080000Z\n20260929\/auto\/storage\/goog4_request\n[\da-f]{64}$/u,
  );
  expect(queryOf(url)["X-Goog-Signature"]).toBe("ab".repeat(256));
});

test("the signer's token is resolved on every call and the storage's is not touched", async () => {
  stubFetch(() => signedBlob(new Uint8Array(256)));

  const storageCredentials = vi.fn<() => GcsCredentials>(() => ({ accessToken }));
  const signerCredentials = vi.fn<() => GcsCredentials>(() => ({ accessToken: signerToken }));
  const storage = iamSigningStorage(signerCredentials, { credentials: storageCredentials });

  await storage.presignGet("object", { expiresIn: 300 });
  await storage.presignPut("object", putOptions);

  expect(signerCredentials.mock.calls).toEqual([
    [{ forceRefresh: false }],
    [{ forceRefresh: false }],
  ]);
  expect(storageCredentials).not.toHaveBeenCalled();
});

test("after `401` with `invalid_token` the signer's token is refreshed and `signBlob` sent again", async () => {
  const answers = [refusedToken(), signedBlob(new Uint8Array(256))];
  const sent = stubFetch(() => answers.shift() ?? refusedToken());
  const signerCredentials = vi.fn<(resolving?: ResolverOptions) => GcsCredentials>((resolving) => ({
    accessToken: resolving?.forceRefresh === true ? "ya29.fresh" : signerToken,
  }));

  await iamSigningStorage(signerCredentials, { retry: false }).presignGet("object", {
    expiresIn: 300,
  });

  expect(signerCredentials.mock.calls).toEqual([
    [{ forceRefresh: false }],
    [{ forceRefresh: true }],
  ]);
  expect(sent.map((request) => request.headers.get("authorization"))).toEqual([
    `Bearer ${signerToken}`,
    "Bearer ya29.fresh",
  ]);
});

test("a second refusal of the signer's token is `InvalidCredentials` after two attempts", async () => {
  stubFetch(() => refusedToken());

  const refusal = await failureOf(
    async () =>
      await iamSigningStorage({ accessToken: signerToken }).presignGet("object", {
        expiresIn: 300,
      }),
  );

  expect(refusal).toMatchObject({
    code: "InvalidCredentials",
    operation: "presignGet",
    key: "object",
    attempts: 2,
    status: 401,
  });
});

test("`403` from `signBlob` is `AccessDenied`, a service account that does not exist included", async () => {
  stubFetch(() =>
    Response.json(
      {
        error: {
          code: 403,
          message:
            "Permission 'iam.serviceAccounts.signBlob' denied on resource (or it may not exist).",
          status: "PERMISSION_DENIED",
        },
      },
      { status: 403 },
    ),
  );

  const refusal = await failureOf(
    async () =>
      await iamSigningStorage({ accessToken: signerToken }).presignPut("object", putOptions),
  );

  expect(refusal).toMatchObject({
    code: "AccessDenied",
    operation: "presignPut",
    key: "object",
    status: 403,
    attempts: 1,
    message: "Permission 'iam.serviceAccounts.signBlob' denied on resource (or it may not exist).",
  });
});

test("a transient failure of `signBlob` is repeated on the budget of spec 9.5", async () => {
  const answers = [new Response("", { status: 503 }), signedBlob(new Uint8Array(256))];
  const sent = stubFetch(() => answers.shift() ?? new Response("", { status: 503 }));

  vi.useRealTimers();

  await iamSigningStorage({ accessToken: signerToken }).presignGet("object", { expiresIn: 300 });

  expect(sent).toHaveLength(2);
});

test("an answer of `signBlob` without a signature is `ProviderError`", async () => {
  stubFetch(() => Response.json({ keyId: "0123456789abcdef" }));

  const refusal = await failureOf(
    async () =>
      await iamSigningStorage({ accessToken: signerToken }).presignGet("object", {
        expiresIn: 300,
      }),
  );

  expect(refusal).toMatchObject({ code: "ProviderError", operation: "presignGet", key: "object" });
});

test("a resolved signer token of the wrong shape is `InvalidCredentials` before any request", async () => {
  const sent = stubFetch(() => signedBlob(new Uint8Array(256)));

  const refusal = await failureOf(
    async () =>
      await iamSigningStorage({ accessToken: "" }).presignGet("object", { expiresIn: 300 }),
  );

  expect(refusal).toMatchObject({
    code: "InvalidCredentials",
    operation: "presignGet",
    attempts: 0,
  });
  expect(sent).toEqual([]);
});

test("the options are checked before `signBlob` is sent", async () => {
  const sent = stubFetch(() => signedBlob(new Uint8Array(256)));

  await failureOf(
    async () =>
      await iamSigningStorage({ accessToken: signerToken }).presignGet("object", { expiresIn: 0 }),
  );
  await failureOf(
    async () => await iamSigningStorage({ accessToken: signerToken }).presignPut("", putOptions),
  );

  expect(sent).toEqual([]);
});
