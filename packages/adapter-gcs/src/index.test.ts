import {
  isStorageError,
  type ListOptions,
  type PutOptions,
  type StorageError,
} from "@stowage/core";
import { afterEach, expect, test, vi } from "vitest";

import { type GcsAdapterOptions, type GcsCredentials, gcsStorage } from "./index.ts";

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

interface SentRequest {
  readonly url: string;
  readonly method: string;
  readonly headers: Headers;
  readonly body: BodyInit | null | undefined;
  readonly signal: AbortSignal | null | undefined;
}

/** What `fetch` was called with, in order, while it answered `answer`. */
function stubFetch(answer: (request: SentRequest) => Response | Promise<Response>): SentRequest[] {
  const sent: SentRequest[] = [];

  vi.stubGlobal("fetch", async (url: string, init: RequestInit): Promise<Response> => {
    const request: SentRequest = {
      url,
      method: init.method ?? "GET",
      headers: new Headers(init.headers),
      body: init.body,
      signal: init.signal,
    };

    sent.push(request);

    return await answer(request);
  });

  return sent;
}

const updated = "2026-09-29T07:12:03.456Z";

/** The object resource the JSON API answers an upload and a metadata read with. */
function resource(fields: Record<string, unknown> = {}): Response {
  return Response.json({
    kind: "storage#object",
    name: "object",
    bucket: "conformance",
    generation: "1790665923456000",
    metageneration: "1",
    contentType: "text/plain",
    size: "5",
    etag: "CIDw3uCR2YgDEAE=",
    updated,
    timeCreated: updated,
    ...fields,
  });
}

function media(body: string): Response {
  return new Response(body, {
    status: 200,
    headers: { "content-type": "text/plain", "x-goog-generation": "1790665923456000" },
  });
}

function notFound(): Response {
  return Response.json(
    {
      error: {
        code: 404,
        message: "No such object: conformance/absent",
        errors: [{ message: "No such object: conformance/absent", reason: "notFound" }],
      },
    },
    { status: 404, headers: { "x-guploader-uploadid": "upload-1" } },
  );
}

/** Answers the resource request and the media download of `get` for one stored body. */
function stored(body: string, fields: Record<string, unknown> = {}) {
  return (request: SentRequest): Response =>
    request.url.includes("alt=media")
      ? media(body)
      : resource({ size: String(new TextEncoder().encode(body).byteLength), ...fields });
}

const accessToken = "ya29.a0AfB_byC";

function storage(overrides: Partial<GcsAdapterOptions> = {}) {
  return gcsStorage({ bucket: "conformance", credentials: { accessToken }, ...overrides });
}

async function failureOf(operation: () => Promise<unknown>): Promise<StorageError> {
  const failure = await operation().then(
    () => undefined,
    (reason: unknown) => reason,
  );

  if (isStorageError(failure)) return failure;

  throw new Error(`The operation did not fail with a StorageError: ${String(failure)}`);
}

function byUrl(one: SentRequest, other: SentRequest): number {
  return one.url.localeCompare(other.url);
}

async function bodyText(body: BodyInit | null | undefined): Promise<string> {
  return await new Response(body).text();
}

/**
 * The bytes of the media part of a multipart upload: between the blank line that ends its
 * head and the closing delimiter. `latin1` reads one character per byte, so an offset in
 * the text is one in the body.
 */
async function mediaBytesOf(request: SentRequest | undefined): Promise<Uint8Array> {
  const boundary = /boundary=(\S+)$/u.exec(request?.headers.get("content-type") ?? "")?.[1];
  const body = new Uint8Array(await new Response(request?.body).arrayBuffer());
  const text = new TextDecoder("latin1").decode(body);
  const mediaPart = text.indexOf(`--${boundary}`, 1);
  const start = text.indexOf("\r\n\r\n", mediaPart) + 4;
  const end = text.lastIndexOf(`\r\n--${boundary}--`);

  return body.subarray(start, end);
}

function signingStorage() {
  return gcsStorage({ bucket: "conformance", credentials: { accessToken }, signer });
}

const signer = {
  serviceAccount: "stowage-conformance@stowage-conformance.iam.gserviceaccount.com",
  credentials: { accessToken: "ya29.signer" },
};

// Identity and declaration

test("the storage names its provider and its bucket", () => {
  const constructed = storage();

  expect(constructed.provider).toBe("gcs");
  expect(constructed.bucket).toBe("conformance");
});

test("without a signer it declares every capability of spec 9.1 but `presignedUrls`", () => {
  expect(storage().capabilities).toEqual([
    "keyBytesPreserved",
    "rangeReads",
    "userMetadata",
    "userMetadataTokenKeys",
  ]);
});

test("with a signer it declares `presignedUrls` as well", () => {
  expect(signingStorage().capabilities).toEqual([
    "keyBytesPreserved",
    "presignedUrls",
    "rangeReads",
    "userMetadata",
    "userMetadataTokenKeys",
  ]);
});

test("the declaration is fixed at construction", () => {
  const { capabilities } = storage();

  expect(Object.isFrozen(capabilities)).toBe(true);
});

test("the two presigning methods exist where a signer is configured, and nowhere else", () => {
  const signing = signingStorage();
  const plain = storage();

  expect(typeof signing.presignGet).toBe("function");
  expect(typeof signing.presignPut).toBe("function");
  expect("presignGet" in plain).toBe(false);
  expect("presignPut" in plain).toBe(false);
});

test("a configuration spec 9.1 refuses throws where the storage is constructed", () => {
  const sent = stubFetch(() => resource());

  expect(() => storage({ multipart: { partSize: 1 } })).toThrow(
    expect.objectContaining({ code: "InvalidOption" }),
  );
  expect(sent).toEqual([]);
});

// Requests and the bearer token

test("`put` of held bytes goes as one multipart upload to the JSON API", async () => {
  const sent = stubFetch(() => resource({ name: "object", size: "5", contentType: "text/plain" }));

  await storage().put("object", new TextEncoder().encode("hello"), { contentType: "text/plain" });

  expect(sent).toHaveLength(1);
  expect(sent[0]?.method).toBe("POST");
  expect(sent[0]?.url).toBe(
    "https://storage.googleapis.com/upload/storage/v1/b/conformance/o?uploadType=multipart",
  );
  expect(sent[0]?.headers.get("authorization")).toBe(`Bearer ${accessToken}`);
  expect(sent[0]?.headers.get("content-type")).toMatch(/^multipart\/related; boundary=\S+$/u);
});

test("the upload body holds the name and the content type, then the bytes", async () => {
  const sent = stubFetch(() => resource());

  await storage().put("a/b.txt", "hello", { contentType: "text/plain" });

  const boundary = /boundary=(\S+)$/u.exec(sent[0]?.headers.get("content-type") ?? "")?.[1];
  const parts = (await bodyText(sent[0]?.body)).split(`--${boundary}`);

  expect(parts).toHaveLength(4);
  expect(parts[0]).toBe("");
  expect(parts[3]).toBe("--\r\n");

  const [metadataHead = "", metadata = ""] = (parts[1] ?? "").split("\r\n\r\n");
  const [mediaHead = "", bytes = ""] = (parts[2] ?? "").split("\r\n\r\n");

  expect(metadataHead).toBe("\r\nContent-Type: application/json; charset=UTF-8");
  expect(JSON.parse(metadata)).toEqual({ name: "a/b.txt", contentType: "text/plain" });
  expect(mediaHead).toBe("\r\nContent-Type: text/plain");
  expect(bytes).toBe("hello\r\n");
});

test("`put` names `application/octet-stream` where no content type was given", async () => {
  const sent = stubFetch(() => resource());

  await storage().put("object", new Uint8Array([1, 2, 3]));

  const text = await bodyText(sent[0]?.body);

  expect(text).toContain('"contentType":"application/octet-stream"');
  expect(text).toContain("Content-Type: application/octet-stream");
});

test("a string travels as its UTF-8 bytes", async () => {
  const sent = stubFetch(() => resource());

  await storage().put("object", "Grüße");

  expect(await mediaBytesOf(sent[0])).toEqual(new TextEncoder().encode("Grüße"));
});

test("the bytes travel unchanged, whatever they hold", async () => {
  const sent = stubFetch(() => resource());
  const bytes = Uint8Array.from({ length: 256 }, (_, index) => index);

  await storage().put("object", bytes);

  expect(await mediaBytesOf(sent[0])).toEqual(bytes);
});

test("`put` resolves with the object the answer describes", async () => {
  stubFetch(() => resource({ name: "object", size: "5", contentType: "text/plain", etag: "CAE=" }));

  const written = await storage().put("object", "hello", { contentType: "text/plain" });

  expect(written).toEqual({
    key: "object",
    size: 5,
    lastModified: new Date(updated),
    etag: "CAE=",
    contentType: "text/plain",
    userMetadata: {},
  });
});

test("an answer that describes no size is a `ProviderError`, not a size made up", async () => {
  stubFetch(() => resource({ size: undefined }));

  const failure = await failureOf(() => storage().put("object", "hello"));

  expect(failure.code).toBe("ProviderError");
});

test("a key is encoded as one path segment, its slashes included", async () => {
  const sent = stubFetch(stored("hello"));

  await storage().stat("a b/c#d%e?f+g'h(i)*!/grüße");

  expect(sent[0]?.url).toBe(
    "https://storage.googleapis.com/storage/v1/b/conformance/o/a%20b%2Fc%23d%25e%3Ff%2Bg%27h%28i%29%2A%21%2Fgr%C3%BC%C3%9Fe",
  );
});

test("a `..` inside a segment and a key ending in a slash reach the provider as written", async () => {
  const sent = stubFetch(notFound);

  await failureOf(() => storage().stat("a..b/"));

  expect(sent[0]?.url).toBe("https://storage.googleapis.com/storage/v1/b/conformance/o/a..b%2F");
});

test("the path of the endpoint is the prefix of every request path", async () => {
  const sent = stubFetch(stored("hello"));
  const behindAPrefix = storage({ endpoint: "http://127.0.0.1:4443/gcs base" });

  await behindAPrefix.put("object", "hello");
  await behindAPrefix.get("object");

  expect(sent.toSorted(byUrl).map((request) => request.url)).toEqual([
    "http://127.0.0.1:4443/gcs%20base/storage/v1/b/conformance/o/object",
    "http://127.0.0.1:4443/gcs%20base/storage/v1/b/conformance/o/object?alt=media",
    "http://127.0.0.1:4443/gcs%20base/upload/storage/v1/b/conformance/o?uploadType=multipart",
  ]);
});

test("the resolver is called before every request, and nothing is kept between them", async () => {
  const tokens = ["first", "second", "third"];
  const resolve = vi.fn<() => GcsCredentials>(() => ({ accessToken: tokens.shift() ?? "later" }));
  const sent = stubFetch(stored("hello"));
  const resolving = storage({ credentials: resolve });

  await resolving.put("object", "hello");
  await resolving.stat("object");

  expect(resolve).toHaveBeenCalledTimes(2);
  expect(resolve).toHaveBeenCalledWith({ forceRefresh: false });
  expect(sent.map((request) => request.headers.get("authorization"))).toEqual([
    "Bearer first",
    "Bearer second",
  ]);
});

test("`get` resolves the credential for each of its two requests", async () => {
  const resolve = vi.fn<() => GcsCredentials>(() => ({ accessToken }));

  stubFetch(stored("hello"));

  await storage({ credentials: resolve }).get("object");

  expect(resolve).toHaveBeenCalledTimes(2);
});

test("a credential the checks refuse is `InvalidCredentials` before any request", async () => {
  const sent = stubFetch(() => resource());
  // oxlint-disable-next-line no-unsafe-type-assertion -- a resolver written in JavaScript
  const credentials = (() => ({ accessToken, projectId: "p" })) as () => GcsCredentials;

  const failure = await failureOf(() => storage({ credentials }).put("object", "hello"));

  expect(failure.code).toBe("InvalidCredentials");
  expect(failure.message).toContain("`projectId`");
  expect(failure.attempts).toBe(0);
  expect(failure.operation).toBe("put");
  expect(failure.key).toBe("object");
  expect(failure.bucket).toBe("conformance");
  expect(sent).toEqual([]);
});

// Keys

test.each([
  [".well-known/acme-challenge/token", "a key below the ACME challenge path"],
  ["a￾b", "a key holding U+FFFE"],
  ["a￿b", "a key holding U+FFFF"],
])("`put` refuses %j before any request: %s", async (key) => {
  const sent = stubFetch(() => resource());

  const failure = await failureOf(() => storage().put(key, "hello"));

  expect(failure.code).toBe("InvalidKey");
  expect(failure.attempts).toBe(0);
  expect(failure.key).toBe(key);
  expect(sent).toEqual([]);
});

test.each([
  [".well-known/acme-challenge-x", "a sibling of the challenge path"],
  ["a/.well-known/acme-challenge/token", "the challenge path below another segment"],
  ["a﷐b", "another noncharacter"],
  ["a\u0085b", "a C1 control"],
])("`put` writes %j: %s", async (key) => {
  const sent = stubFetch(() => resource());

  await storage().put(key, "hello");

  expect(sent).toHaveLength(1);
});

test("`put` refuses a key the core rule refuses", async () => {
  const sent = stubFetch(() => resource());

  const failure = await failureOf(() => storage().put("a/../b", "hello"));

  expect(failure.code).toBe("InvalidKey");
  expect(sent).toEqual([]);
});

test.each([[".well-known/acme-challenge/token"], ["a￾b"]])(
  "`get`, `stat` and `exists` address %j as the core rule has it",
  async (key) => {
    const sent = stubFetch(notFound);
    const addressing = storage();

    await failureOf(() => addressing.get(key));
    await failureOf(() => addressing.stat(key));
    await addressing.exists(key);

    expect(sent.length).toBeGreaterThanOrEqual(3);
  },
);

// `put` options

test("an unknown option of `put` is `InvalidOption` naming it, before any request", async () => {
  const sent = stubFetch(() => resource());
  // oxlint-disable-next-line no-unsafe-type-assertion -- the point of the test
  const options = { storageClass: "NEARLINE" } as PutOptions;

  const failure = await failureOf(() => storage().put("object", "hello", options));

  expect(failure.code).toBe("InvalidOption");
  expect(failure.message).toContain("`storageClass`");
  expect(sent).toEqual([]);
});

test.each([[""], ["text/plain\r\nX-Injected: 1"]])(
  "the content type %j is `InvalidOption`",
  async (contentType) => {
    const sent = stubFetch(() => resource());

    const failure = await failureOf(() => storage().put("object", "hello", { contentType }));

    expect(failure.code).toBe("InvalidOption");
    expect(failure.message).toContain("`contentType`");
    expect(sent).toEqual([]);
  },
);

// User metadata

/** The object resource the first part of a multipart upload carries. */
async function uploadedResource(request: SentRequest | undefined): Promise<unknown> {
  const boundary = /boundary=(\S+)$/u.exec(request?.headers.get("content-type") ?? "")?.[1];
  const [, part = ""] = (await bodyText(request?.body)).split(`--${boundary}`);
  const [, json = ""] = part.split("\r\n\r\n");

  return JSON.parse(json);
}

test("`put` sends each user metadata key folded to lower case, its value as written", async () => {
  const sent = stubFetch(() => resource());

  await storage().put("object", "hello", {
    userMetadata: { WrittenBy: "stowage", "Content-Hash": "  grüße =?UTF-8?B?eA==?= 😀 " },
  });

  expect(await uploadedResource(sent[0])).toMatchObject({
    metadata: { writtenby: "stowage", "content-hash": "  grüße =?UTF-8?B?eA==?= 😀 " },
  });
});

test("`put` without user metadata sends no `metadata`", async () => {
  const sent = stubFetch(() => resource());

  await storage().put("object", "hello", { userMetadata: {} });

  expect(await uploadedResource(sent[0])).not.toHaveProperty("metadata");
});

test.each([
  ["two keys that differ in case alone", { key: "a", KEY: "b" }],
  ["a key that is no HTTP token", { "a b": "c" }],
  ["a value holding a lone surrogate", { key: "\uD800" }],
  ["a set above 2 KB", { key: "x".repeat(2048) }],
])("`put` refuses %s before any request", async (_, userMetadata) => {
  const sent = stubFetch(() => resource());

  const failure = await failureOf(() => storage().put("object", "hello", { userMetadata }));

  expect(failure).toMatchObject({
    code: "InvalidRequest",
    operation: "put",
    key: "object",
    attempts: 0,
  });
  expect(sent).toEqual([]);
});

test("`put` resolves with the user metadata the answer describes", async () => {
  stubFetch(() => resource({ metadata: { writtenby: "stowage" } }));

  const described = await storage().put("object", "hello", {
    userMetadata: { WrittenBy: "stowage" },
  });

  expect(described.userMetadata).toEqual({ writtenby: "stowage" });
});

test("`stat` and `get` hand the keys back as stored, `A` beside `a`", async () => {
  stubFetch(stored("hello", { metadata: { A: "upper", a: "lower" } }));

  expect((await storage().stat("object")).userMetadata).toEqual({ A: "upper", a: "lower" });
  expect((await storage().get("object")).stat.userMetadata).toEqual({ A: "upper", a: "lower" });
});

test("a stored value holding RFC 2047 encoded words is decoded on the way back", async () => {
  stubFetch(stored("hello", { metadata: { greeting: "=?UTF-8?B?Z3LDvMOfZQ==?= =?UTF-8?Q?_w?=" } }));

  expect((await storage().stat("object")).userMetadata).toEqual({ greeting: "grüße w" });
});

test("a resource without `metadata` holds no user metadata", async () => {
  stubFetch(stored("hello"));

  expect((await storage().stat("object")).userMetadata).toEqual({});
});

test("a signal that already fired rejects `put` with `AbortError` before any request", async () => {
  const sent = stubFetch(() => resource());

  await expect(
    storage().put("object", "hello", { signal: AbortSignal.abort() }),
  ).rejects.toMatchObject({ name: "AbortError" });
  expect(sent).toEqual([]);
});

// `get`

test("`get` sends the resource request and the media download side by side", async () => {
  const bothSent = Promise.withResolvers<void>();
  let arrived = 0;
  const sent = stubFetch(async (request) => {
    arrived += 1;
    if (arrived === 2) bothSent.resolve();

    // Neither answers before the other went out, which a `get` sending them in turn
    // would wait for forever.
    await bothSent.promise;

    return stored("hello")(request);
  });

  const read = await storage().get("object");

  expect(sent.toSorted(byUrl).map((request) => [request.method, request.url])).toEqual([
    ["GET", "https://storage.googleapis.com/storage/v1/b/conformance/o/object"],
    ["GET", "https://storage.googleapis.com/storage/v1/b/conformance/o/object?alt=media"],
  ]);
  expect(sent.every((request) => request.headers.get("authorization") !== null)).toBe(true);
  expect(await read.text()).toBe("hello");
});

test("`get` describes the object by its resource and reads the body off the download", async () => {
  stubFetch(stored("hello", { contentType: "text/markdown", etag: "CAE=" }));

  const read = await storage().get("object");

  expect(read.stat).toEqual({
    key: "object",
    size: 5,
    lastModified: new Date(updated),
    etag: "CAE=",
    contentType: "text/markdown",
    userMetadata: {},
  });
  expect(await read.bytes()).toEqual(new TextEncoder().encode("hello"));
});

test("the body of a stored object is read once", async () => {
  stubFetch(stored("hello"));

  const read = await storage().get("object");

  await read.text();

  const failure = await failureOf(() => read.bytes());

  expect(failure.code).toBe("InvalidRequest");
});

test("`get` of a missing key is `NotFound` naming the key after one attempt", async () => {
  stubFetch((request) =>
    request.url.includes("alt=media")
      ? new Response("No such object: conformance/absent", { status: 404 })
      : notFound(),
  );

  const failure = await failureOf(() => storage().get("absent"));

  expect(failure).toMatchObject({
    code: "NotFound",
    key: "absent",
    operation: "get",
    status: 404,
    retryable: false,
    attempts: 1,
  });
});

test("a failed resource request cancels the media download beside it", async () => {
  let download: SentRequest | undefined;

  stubFetch(async (request) => {
    if (!request.url.includes("alt=media")) return notFound();

    download = request;

    return await new Promise<Response>((_, reject) => {
      request.signal?.addEventListener("abort", () => reject(request.signal?.reason));
    });
  });

  const failure = await failureOf(() => storage().get("absent"));

  expect(failure.code).toBe("NotFound");
  expect(download?.signal?.aborted).toBe(true);
});

test("an incomplete resource description stays a `ProviderError` when media cancellation fails", async () => {
  const cancel = vi.fn<() => Promise<void>>(() =>
    Promise.reject(new Error("media cancellation failed")),
  );

  stubFetch((request) =>
    request.url.includes("alt=media")
      ? new Response(new ReadableStream({ cancel }), { status: 200 })
      : resource({ size: undefined }),
  );

  const failure = await failureOf(() => storage().get("object"));

  expect(failure).toMatchObject({
    code: "ProviderError",
    key: "object",
    operation: "get",
    status: 200,
    message: expect.stringContaining("no size"),
  });
  expect(cancel).toHaveBeenCalledOnce();
});

test("the caller's abort reaches both requests of `get`", async () => {
  const controller = new AbortController();
  const sent = stubFetch(
    async (request) =>
      await new Promise<Response>((_, reject) => {
        request.signal?.addEventListener("abort", () => reject(request.signal?.reason));
        if (request.url.includes("alt=media")) controller.abort();
      }),
  );

  await expect(storage().get("object", { signal: controller.signal })).rejects.toMatchObject({
    name: "AbortError",
  });
  expect(sent.every((request) => request.signal?.aborted === true)).toBe(true);
});

test("a signal that already fired rejects `get` before any request", async () => {
  const sent = stubFetch(stored("hello"));

  await expect(storage().get("object", { signal: AbortSignal.abort() })).rejects.toMatchObject({
    name: "AbortError",
  });
  expect(sent).toEqual([]);
});

// `stat` and `exists`

test("`stat` reads the object's resource alone", async () => {
  const sent = stubFetch(stored("hello"));

  const described = await storage().stat("object");

  expect(sent).toHaveLength(1);
  expect(sent[0]?.url).toBe("https://storage.googleapis.com/storage/v1/b/conformance/o/object");
  expect(described.size).toBe(5);
  expect(described.lastModified).toEqual(new Date(updated));
});

test("`stat` of a missing key is `NotFound`", async () => {
  stubFetch(notFound);

  const failure = await failureOf(() => storage().stat("absent"));

  expect(failure).toMatchObject({ code: "NotFound", operation: "stat", key: "absent" });
});

test("`exists` answers true for a stored key and false for a missing one", async () => {
  stubFetch((request) => (request.url.endsWith("/absent") ? notFound() : resource()));

  expect(await storage().exists("object")).toBe(true);
  expect(await storage().exists("absent")).toBe(false);
});

test("`exists` rethrows every failure but `NotFound`", async () => {
  stubFetch(() =>
    Response.json(
      { error: { code: 403, message: "denied", errors: [{ reason: "forbidden" }] } },
      { status: 403 },
    ),
  );

  const failure = await failureOf(() => storage().exists("object"));

  expect(failure.code).toBe("AccessDenied");
});

test("`exists` refuses an addressable key the core rule refuses", async () => {
  const sent = stubFetch(() => resource());

  const failure = await failureOf(() => storage().exists("a/../b"));

  expect(failure.code).toBe("InvalidKey");
  expect(sent).toEqual([]);
});

// Failures (spec 9.8)

/** The error document of the JSON API, as GCS answers a failure on a JSON path. */
function errorDocument(
  status: number,
  providerCode: string,
  message: string,
  headers: Record<string, string> = {},
): Response {
  return Response.json(
    {
      error: {
        code: status,
        message,
        errors: [{ message, domain: "global", reason: providerCode }],
      },
    },
    { status, headers: { "x-guploader-uploadid": "upload-1", ...headers } },
  );
}

function textAnswer(
  status: number,
  body: string,
  contentType = "text/html; charset=UTF-8",
): Response {
  return new Response(body, {
    status,
    headers: { "content-type": contentType, "x-guploader-uploadid": "upload-1" },
  });
}

const missingBucket = "The specified bucket does not exist.";

test("an error document is read whatever its `Content-Type` says", async () => {
  stubFetch(() => {
    const document = errorDocument(400, "invalidArgument", "Invalid argument.");

    return new Response(document.body, {
      status: 400,
      headers: { "content-type": "text/html; charset=UTF-8", "x-guploader-uploadid": "upload-1" },
    });
  });

  const failure = await failureOf(() => storage().put("object", "hello"));

  expect(failure).toMatchObject({
    code: "InvalidRequest",
    message: "Invalid argument.",
    providerCode: "invalidArgument",
    status: 400,
    requestId: "upload-1",
    retryable: false,
    attempts: 1,
  });
});

test.each([
  ["forbidden", 403, "AccessDenied"],
  ["insufficientPermissions", 403, "AccessDenied"],
  ["objectUnderActiveHold", 403, "ProviderError"],
  ["retentionPolicyNotMet", 403, "ProviderError"],
  ["authError", 401, "InvalidCredentials"],
  ["required", 401, "InvalidCredentials"],
  ["invalidArgument", 400, "InvalidRequest"],
  ["requestedRangeNotSatisfiable", 416, "InvalidRequest"],
  ["uploadTooLarge", 400, "InvalidRequest"],
  ["invalid", 400, "ProviderError"],
  ["conditionNotMet", 412, "ProviderError"],
  ["conflict", 409, "ProviderError"],
  ["clientClosedRequest", 499, "ProviderError"],
])("the provider code `%s` answered with %i is `%s`", async (providerCode, status, code) => {
  stubFetch(() => errorDocument(status, providerCode, "The provider said so."));

  const failure = await failureOf(() => storage().stat("object"));

  expect(failure).toMatchObject({ code, providerCode, message: "The provider said so." });
});

test("a provider code the table does not name leaves the status to decide", async () => {
  stubFetch(() => errorDocument(403, "accountDisabled", "The account is disabled."));

  const failure = await failureOf(() => storage().stat("object"));

  expect(failure).toMatchObject({ code: "AccessDenied", providerCode: "accountDisabled" });
});

test("`retryable` follows the status and never the provider code", async () => {
  vi.spyOn(Math, "random").mockReturnValue(0);
  stubFetch(() => errorDocument(503, "forbidden", "Backend Error"));

  const failure = await failureOf(() => storage().stat("object"));

  expect(failure).toMatchObject({ code: "AccessDenied", retryable: true, status: 503 });
});

test("a body that is no JSON is the message, its character references decoded", async () => {
  // A race: the object went away between the resource request and the media download.
  stubFetch((request) =>
    request.url.includes("alt=media")
      ? textAnswer(404, "No such object: conformance/it&#39;s &amp; &#x201C;that&#x201D; &lt;b&gt;")
      : resource(),
  );

  const failure = await failureOf(() => storage().get("object"));

  expect(failure).toMatchObject({
    code: "NotFound",
    key: "object",
    message: "No such object: conformance/it's & “that” <b>",
    status: 404,
    requestId: "upload-1",
  });
  expect(failure.providerCode).toBeUndefined();
});

test("a character reference that names no character stays as written", async () => {
  stubFetch((request) =>
    request.url.includes("alt=media")
      ? textAnswer(403, "A &#0; B &#xD800; C &nbsp; D &")
      : resource(),
  );

  const failure = await failureOf(() => storage().get("object"));

  expect(failure).toMatchObject({
    code: "AccessDenied",
    message: "A &#0; B &#xD800; C &nbsp; D &",
  });
});

test("a body that starts with `<` is not read, and the message names the status", async () => {
  vi.spyOn(Math, "random").mockReturnValue(0);
  stubFetch(() =>
    textAnswer(502, "<!DOCTYPE html><html><title>Error 502 (Server Error)!!1</title></html>"),
  );

  const failure = await failureOf(() => storage().stat("object"));

  expect(failure).toMatchObject({ code: "ProviderError", status: 502, retryable: true });
  expect(failure.message).toContain("502");
  expect(failure.message).not.toContain("<");
  expect(failure.providerCode).toBeUndefined();
});

test("an empty body leaves the message to name the status", async () => {
  stubFetch(() => new Response(null, { status: 403 }));

  const failure = await failureOf(() => storage().stat("object"));

  expect(failure).toMatchObject({ code: "AccessDenied", status: 403 });
  expect(failure.message).toContain("403");
});

test("a `404` without `notFound` on the resource says that the endpoint serves no such path", async () => {
  stubFetch(() => textAnswer(404, "Not Found"));

  const failure = await failureOf(() => storage().stat("object"));

  expect(failure).toMatchObject({
    code: "ProviderError",
    status: 404,
    retryable: false,
    attempts: 1,
    key: "object",
  });
  expect(failure.message).toContain("serves no such path");
  expect(failure.message).toContain("Not Found");
  expect(failure.providerCode).toBeUndefined();
});

test.each([
  ["`stat`", () => storage().stat("object")],
  ["`exists`", () => storage().exists("object")],
  ["`get`", () => storage().get("object")],
  ["`put`", () => storage().put("object", "hello")],
  ["`list`", () => storage().list().page()],
])(
  "%s rejects a `404` without a provider code rather than reading it as absence",
  async (_, call) => {
    stubFetch(() => textAnswer(404, "<html><body>Not Found</body></html>"));

    const failure = await failureOf(call);

    expect(failure.code).toBe("ProviderError");
    expect(failure.message).toContain("serves no such path");
  },
);

test.each([
  ["put", () => storage().put("object", "hello")],
  ["get", () => storage().get("object")],
  ["stat", () => storage().stat("object")],
  ["exists", () => storage().exists("object")],
  ["list", () => storage().list().page()],
])("a missing bucket is `NotFound` without `key` on `%s`", async (operation, call) => {
  stubFetch((request) =>
    request.url.includes("alt=media")
      ? textAnswer(404, missingBucket)
      : errorDocument(404, "notFound", missingBucket),
  );

  const failure = await failureOf(call);

  expect(failure).toMatchObject({
    code: "NotFound",
    operation,
    bucket: "conformance",
    message: missingBucket,
    providerCode: "notFound",
    status: 404,
  });
  expect(failure.key).toBeUndefined();
});

test("a missing bucket told by the media download alone is `NotFound` without `key`", async () => {
  stubFetch((request) =>
    request.url.includes("alt=media") ? textAnswer(404, missingBucket) : resource(),
  );

  const failure = await failureOf(() => storage().get("object"));

  expect(failure).toMatchObject({ code: "NotFound", message: missingBucket });
  expect(failure.key).toBeUndefined();
});

test("a key above 1024 bytes answered `404 notFound` is `NotFound`, and absent to `exists`", async () => {
  const long = "k".repeat(1025);

  stubFetch(() => errorDocument(404, "notFound", `No such object: conformance/${long}`));

  const failure = await failureOf(() => storage().stat(long));

  expect(failure).toMatchObject({ code: "NotFound", key: long });
  expect(await storage().exists(long)).toBe(false);
});

// Retries (spec 9.5)

test.each([[408], [429], [500], [502], [503], [504]])(
  "a `%i` is repeated, and an attempt that succeeds resolves the call",
  async (status) => {
    vi.spyOn(Math, "random").mockReturnValue(0);

    const answers = [errorDocument(status, "backendError", "Try again."), resource()];
    const sent = stubFetch(() => answers.shift() ?? resource());

    const described = await storage().stat("object");

    expect(sent).toHaveLength(2);
    expect(described.size).toBe(5);
  },
);

test("three attempts are the default, and the error counts them", async () => {
  vi.spyOn(Math, "random").mockReturnValue(0);

  const sent = stubFetch(() => errorDocument(503, "backendError", "Backend Error"));

  const failure = await failureOf(() => storage().stat("object"));

  expect(sent).toHaveLength(3);
  expect(failure).toMatchObject({ code: "ProviderError", retryable: true, attempts: 3 });
});

test("`maxAttempts` bounds the attempts, and `retry: false` sends one", async () => {
  vi.spyOn(Math, "random").mockReturnValue(0);

  const sent = stubFetch(() => errorDocument(503, "backendError", "Backend Error"));

  expect(
    await failureOf(() => storage({ retry: { maxAttempts: 2 } }).stat("object")),
  ).toMatchObject({ attempts: 2 });
  expect(await failureOf(() => storage({ retry: false }).stat("object"))).toMatchObject({
    attempts: 1,
  });
  expect(sent).toHaveLength(3);
});

test("a transport failure is repeated and ends in `NetworkError`", async () => {
  vi.spyOn(Math, "random").mockReturnValue(0);

  const sent = stubFetch(() => {
    throw new TypeError("fetch failed");
  });

  const failure = await failureOf(() => storage().stat("object"));

  expect(sent).toHaveLength(3);
  expect(failure).toMatchObject({ code: "NetworkError", retryable: true, attempts: 3 });
  expect(failure.cause).toBeInstanceOf(TypeError);
});

test("a failure outside the transient group is not repeated", async () => {
  const sent = stubFetch(() => errorDocument(403, "forbidden", "denied"));

  await failureOf(() => storage().stat("object"));

  expect(sent).toHaveLength(1);
});

test("`Retry-After` is not read", async () => {
  vi.useFakeTimers();

  try {
    vi.spyOn(Math, "random").mockReturnValue(0);

    const answers = [
      errorDocument(429, "rateLimitExceeded", "Slow down.", { "retry-after": "3600" }),
    ];
    const sent = stubFetch(() => answers.shift() ?? resource());
    const described = storage().stat("object");

    await vi.advanceTimersByTimeAsync(0);

    await expect(described).resolves.toMatchObject({ size: 5 });
    expect(sent).toHaveLength(2);
  } finally {
    vi.useRealTimers();
  }
});

// The refused token (spec 9.3)

const refusedToken = {
  "www-authenticate": 'Bearer realm="https://accounts.google.com/", error=invalid_token',
};

function invalidToken(): Response {
  return errorDocument(401, "authError", "Invalid Credentials", refusedToken);
}

test("a token refused as `invalid_token` is resolved again under `forceRefresh` and sent once more", async () => {
  const tokens = ["expired", "fresh"];
  const resolve = vi.fn<() => GcsCredentials>(() => ({ accessToken: tokens.shift() ?? "later" }));
  const sent = stubFetch((request) =>
    request.headers.get("authorization") === "Bearer expired" ? invalidToken() : resource(),
  );

  const described = await storage({ credentials: resolve }).stat("object");

  expect(described.size).toBe(5);
  expect(resolve.mock.calls).toEqual([[{ forceRefresh: false }], [{ forceRefresh: true }]]);
  expect(sent.map((request) => request.headers.get("authorization"))).toEqual([
    "Bearer expired",
    "Bearer fresh",
  ]);
});

test("a failed cancellation of a refused token response still refreshes and repeats", async () => {
  const cancel = vi.fn<() => Promise<void>>(() =>
    Promise.reject(new Error("response cancellation failed")),
  );
  const tokens = ["expired", "fresh"];
  const resolve = vi.fn<() => GcsCredentials>(() => ({ accessToken: tokens.shift() ?? "later" }));
  const sent = stubFetch((request) =>
    request.headers.get("authorization") === "Bearer expired"
      ? new Response(new ReadableStream({ cancel }), { status: 401, headers: refusedToken })
      : resource(),
  );

  await expect(
    storage({ credentials: resolve, retry: false }).stat("object"),
  ).resolves.toMatchObject({
    size: 5,
  });
  expect(cancel).toHaveBeenCalledOnce();
  expect(resolve.mock.calls).toEqual([[{ forceRefresh: false }], [{ forceRefresh: true }]]);
  expect(sent.map((request) => request.headers.get("authorization"))).toEqual([
    "Bearer expired",
    "Bearer fresh",
  ]);
});

test("a second refusal is `InvalidCredentials` after two attempts, saying the token expired or is not accepted", async () => {
  const resolve = vi.fn<() => GcsCredentials>(() => ({ accessToken }));
  const sent = stubFetch(invalidToken);

  const failure = await failureOf(() => storage({ credentials: resolve }).stat("object"));

  expect(sent).toHaveLength(2);
  expect(resolve).toHaveBeenCalledTimes(2);
  expect(failure).toMatchObject({
    code: "InvalidCredentials",
    attempts: 2,
    status: 401,
    providerCode: "authError",
    retryable: false,
  });
  expect(failure.message).toContain("expired or is not accepted");
  expect(failure.message).toContain("Invalid Credentials");
});

test("the repeat after `invalid_token` is not switched off by `retry: false`", async () => {
  const sent = stubFetch(invalidToken);

  const failure = await failureOf(() => storage({ retry: false }).stat("object"));

  expect(sent).toHaveLength(2);
  expect(failure.attempts).toBe(2);
});

test("the repeat after `invalid_token` waits for nothing", async () => {
  vi.useFakeTimers();

  try {
    const answers = [invalidToken()];
    const sent = stubFetch(() => answers.shift() ?? resource());
    const described = storage().stat("object");

    await vi.advanceTimersByTimeAsync(0);

    await expect(described).resolves.toMatchObject({ size: 5 });
    expect(sent).toHaveLength(2);
  } finally {
    vi.useRealTimers();
  }
});

test("a quoted `invalid_token` is the same refusal", async () => {
  const answers = [
    errorDocument(401, "authError", "Invalid Credentials", {
      "www-authenticate": 'Bearer error="invalid_token", error_description="The token expired"',
    }),
  ];
  const sent = stubFetch(() => answers.shift() ?? resource());

  await storage().stat("object");

  expect(sent).toHaveLength(2);
});

test("any other `401` is `InvalidCredentials` and not repeated", async () => {
  const resolve = vi.fn<() => GcsCredentials>(() => ({ accessToken }));
  const sent = stubFetch(() =>
    errorDocument(401, "required", "Login Required.", {
      "www-authenticate": 'Bearer realm="https://accounts.google.com/"',
    }),
  );

  const failure = await failureOf(() => storage({ credentials: resolve }).stat("object"));

  expect(sent).toHaveLength(1);
  expect(resolve).toHaveBeenCalledOnce();
  expect(failure).toMatchObject({
    code: "InvalidCredentials",
    attempts: 1,
    message: "Login Required.",
  });
});

test("a refused token on the media download is repeated as well, and nothing reports `Expired`", async () => {
  const tokens = ["expired", "expired", "fresh", "fresh"];
  const resolve = vi.fn<() => GcsCredentials>(() => ({ accessToken: tokens.shift() ?? "later" }));

  stubFetch((request) => {
    if (request.headers.get("authorization") !== "Bearer expired") return stored("hello")(request);

    return request.url.includes("alt=media")
      ? new Response("Invalid Credentials", { status: 401, headers: refusedToken })
      : invalidToken();
  });

  const read = await storage({ credentials: resolve }).get("object");

  expect(await read.text()).toBe("hello");
  expect(resolve).toHaveBeenCalledTimes(4);
});

// Listings

/** The object resource as `objects.list` carries it in `items`. */
function listed(name: string, fields: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    kind: "storage#object",
    name,
    bucket: "conformance",
    generation: "1790665923456000",
    contentType: "text/plain",
    size: "5",
    etag: "CIDw3uCR2YgDEAE=",
    updated,
    ...fields,
  };
}

function listingAnswer(fields: Record<string, unknown> = {}): Response {
  return Response.json({ kind: "storage#objects", ...fields });
}

test("`page()` sends one `objects.list` with `maxResults` and reads its entries", async () => {
  const sent = stubFetch(() =>
    listingAnswer({ items: [listed("a.txt"), listed("b.txt", { size: "12", etag: "CAE=" })] }),
  );

  const page = await storage().list().page();

  expect(sent.map(({ method, url }) => [method, url])).toEqual([
    ["GET", "https://storage.googleapis.com/storage/v1/b/conformance/o?maxResults=1000"],
  ]);
  expect(page).toEqual({
    objects: [
      { key: "a.txt", size: 5, lastModified: new Date(updated), etag: "CIDw3uCR2YgDEAE=" },
      { key: "b.txt", size: 12, lastModified: new Date(updated), etag: "CAE=" },
    ],
    prefixes: [],
    cursor: undefined,
  });
});

test("a delimiter shapes the page into the objects at the level and its pseudo-directories", async () => {
  const sent = stubFetch(() =>
    listingAnswer({ items: [listed("docs/a.txt")], prefixes: ["docs/one/", "docs/two/"] }),
  );

  const page = await storage().list({ prefix: "docs/", delimiter: "/", pageSize: 10 }).page();

  expect(sent.map(({ url }) => new URL(url).searchParams.toString())).toEqual([
    "maxResults=10&prefix=docs%2F&delimiter=%2F",
  ]);
  expect(page.objects.map(({ key }) => key)).toEqual(["docs/a.txt"]);
  expect(page.prefixes).toEqual(["docs/one/", "docs/two/"]);
});

test("the iteration yields the objects at the level, and no pseudo-directory", async () => {
  stubFetch(() => listingAnswer({ items: [listed("docs/a.txt")], prefixes: ["docs/one/"] }));

  const keys: string[] = [];

  for await (const entry of storage().list({ prefix: "docs/", delimiter: "/" })) {
    keys.push(entry.key);
  }

  expect(keys).toEqual(["docs/a.txt"]);
});

test("a page's cursor continues from its `nextPageToken` in a listing of its own", async () => {
  const sent = stubFetch((request) =>
    new URL(request.url).searchParams.has("pageToken")
      ? listingAnswer({ items: [listed("c.txt")] })
      : listingAnswer({ items: [listed("a.txt"), listed("b.txt")], nextPageToken: "CgViLnR4dA==" }),
  );

  const first = await storage().list({ pageSize: 2 }).page();
  const rest = await storage().list({ pageSize: 2, cursor: first.cursor }).page();

  expect(first.cursor).toEqual(expect.any(String));
  expect(first.cursor).not.toContain("CgViLnR4dA");
  expect(new URL(sent[1]?.url ?? "").searchParams.get("pageToken")).toBe("CgViLnR4dA==");
  expect(new URL(sent[1]?.url ?? "").searchParams.get("maxResults")).toBe("2");
  expect(rest.objects.map(({ key }) => key)).toEqual(["c.txt"]);
  expect(rest.cursor).toBeUndefined();
});

test("the iteration walks every page, sending `maxResults` and the last `nextPageToken`", async () => {
  const pages = new Map([
    ["", listingAnswer({ items: [listed("a.txt")], nextPageToken: "second" })],
    ["second", listingAnswer({ items: [listed("b.txt")], nextPageToken: "third" })],
    ["third", listingAnswer({ items: [listed("c.txt")] })],
  ]);
  const sent = stubFetch(
    (request) =>
      pages.get(new URL(request.url).searchParams.get("pageToken") ?? "") ?? listingAnswer(),
  );

  const keys: string[] = [];

  for await (const entry of storage().list({ pageSize: 1 })) keys.push(entry.key);

  expect(keys).toEqual(["a.txt", "b.txt", "c.txt"]);
  expect(sent.map(({ url }) => new URL(url).searchParams.toString())).toEqual([
    "maxResults=1",
    "maxResults=1&pageToken=second",
    "maxResults=1&pageToken=third",
  ]);
});

test("the iteration rejects a page token sent earlier in the same walk", async () => {
  const pages = new Map([
    ["", { items: [listed("a.txt")], nextPageToken: "second" }],
    ["second", { items: [listed("b.txt")], nextPageToken: "third" }],
    ["third", { items: [listed("c.txt")], nextPageToken: "second" }],
  ]);
  const sent = stubFetch((request) =>
    listingAnswer(pages.get(new URL(request.url).searchParams.get("pageToken") ?? "") ?? {}),
  );

  const { cursor } = await storage().list().page();
  const failure = await failureOf(async () => {
    for await (const entry of storage().list()) void entry;
  });

  expect(failure).toMatchObject({ code: "ProviderError", operation: "list", status: 200 });
  expect(failure.message).toContain("a page token already sent");
  expect(sent).toHaveLength(4);

  const resumed = await storage().list({ cursor }).page();

  expect(resumed.objects.map(({ key }) => key)).toEqual(["b.txt"]);
  expect(resumed.cursor).toEqual(expect.any(String));
});

test.each([
  ["non-array items", { items: {} }, "items that are not an array"],
  ["null items", { items: null }, "items that are not an array"],
  ["non-array prefixes", { prefixes: "docs/" }, "prefixes that are not an array"],
  ["null prefixes", { prefixes: null }, "prefixes that are not an array"],
  ["non-string nextPageToken", { nextPageToken: 3 }, "a nextPageToken that is not a string"],
  ["null nextPageToken", { nextPageToken: null }, "a nextPageToken that is not a string"],
])("a listing with %s is a `ProviderError`", async (_, fields, said) => {
  stubFetch(() => listingAnswer(fields));

  const failure = await failureOf(() => storage().list().page());

  expect(failure).toMatchObject({ code: "ProviderError", operation: "list", status: 200 });
  expect(failure.message).toContain(said);
});

test("an empty nextPageToken still ends a listing", async () => {
  const sent = stubFetch(() => listingAnswer({ nextPageToken: "" }));

  const page = await storage().list().page();

  expect(page).toEqual({ objects: [], prefixes: [], cursor: undefined });
  expect(sent).toHaveLength(1);
});

test.each([
  ["no cursor at all", "this-is-no-cursor-the-storage-handed-out"],
  ["a bare page token", "CgViLnR4dA=="],
  ["a cursor of `adapter-s3`", btoa("stowage-s3-1:0061")],
  ["a cursor under the tag with no position", btoa("stowage-gcs-1:")],
  ["a cursor under the tag holding a lone surrogate", btoa("stowage-gcs-1:d800")],
])("%s is `InvalidOption` naming `cursor` before any request", async (_, cursor) => {
  const sent = stubFetch(() => listingAnswer());

  const failure = await failureOf(() => storage().list({ cursor }).page());

  expect(failure).toMatchObject({ code: "InvalidOption", operation: "list", attempts: 0 });
  expect(failure.message).toContain("`cursor`");
  expect(sent).toEqual([]);
});

test("`invalid` answered to a listing that carried the caller's cursor is `InvalidOption` naming `cursor`", async () => {
  const answers = [
    listingAnswer({ items: [listed("a.txt")], nextPageToken: "expired" }),
    errorDocument(400, "invalid", "Invalid Value"),
  ];

  stubFetch(() => answers.shift() ?? listingAnswer());

  const { cursor } = await storage().list().page();
  const failure = await failureOf(() => storage().list({ cursor }).page());

  expect(failure).toMatchObject({
    code: "InvalidOption",
    operation: "list",
    status: 400,
    providerCode: "invalid",
    attempts: 1,
  });
  expect(failure.message).toContain("`cursor`");
  expect(failure.message).toContain("Invalid Value");
});

test("`invalid` answered to a page the provider's own token asked for stays a `ProviderError`", async () => {
  const answers = [
    listingAnswer({ items: [listed("a.txt")], nextPageToken: "second" }),
    errorDocument(400, "invalid", "Invalid Value"),
  ];

  stubFetch(() => answers.shift() ?? listingAnswer());

  const failure = await failureOf(async () => {
    for await (const entry of storage().list()) void entry;
  });

  expect(failure).toMatchObject({ code: "ProviderError", providerCode: "invalid" });
});

test.each([
  ["no key", { name: undefined }, "an object with no key"],
  ["an empty key", { name: "" }, "an object with no key"],
  ["no size", { size: undefined }, "no size"],
  ["a size that is no count of bytes", { size: "-1" }, "no size"],
  ["no last-modified time", { updated: undefined }, "no last-modified time"],
  ["a last-modified time that is no time", { updated: "yesterday" }, "no last-modified time"],
])("an entry with %s is a `ProviderError`, not a value made up", async (_, fields, said) => {
  stubFetch(() => listingAnswer({ items: [listed("a.txt", fields)] }));

  const failure = await failureOf(() => storage().list().page());

  expect(failure).toMatchObject({ code: "ProviderError", operation: "list", status: 200 });
  expect(failure.message).toContain(said);
});

test("an entry without an etag has none", async () => {
  stubFetch(() => listingAnswer({ items: [listed("a.txt", { etag: undefined })] }));

  const [entry] = (await storage().list().page()).objects;

  expect(entry).toEqual({ key: "a.txt", size: 5, lastModified: new Date(updated) });
});

test("a listing answered with a body that is no JSON is a `ProviderError`", async () => {
  stubFetch(() => textAnswer(200, "<html>Portal</html>"));

  const failure = await failureOf(() => storage().list().page());

  expect(failure).toMatchObject({ code: "ProviderError", operation: "list", status: 200 });
  expect(failure.message).toContain("no JSON");
});

test("a prefix and the keys below it holding `%`, `+` and characters above ASCII travel byte for byte", async () => {
  const prefix = "Grüße/100% a+b/";
  const key = `${prefix}日本語 ключ+%2F.txt`;
  const sent = stubFetch(() => listingAnswer({ items: [listed(key)] }));

  const page = await storage().list({ prefix }).page();

  expect(sent[0]?.url).toContain("&prefix=Gr%C3%BC%C3%9Fe%2F100%25%20a%2Bb%2F");
  expect(new URL(sent[0]?.url ?? "").searchParams.get("prefix")).toBe(prefix);
  expect(page.objects.map((entry) => entry.key)).toEqual([key]);
});

test("`list` sends nothing until the listing is read", async () => {
  const sent = stubFetch(() => listingAnswer());

  const unread = storage().list({ prefix: "docs/" });

  expect(sent).toEqual([]);

  await unread.page();

  expect(sent).toHaveLength(1);
});

test("a listing whose `nextPageToken` repeats the token it was sent is a `ProviderError`", async () => {
  const sent = stubFetch(() => listingAnswer({ items: [listed("a.txt")], nextPageToken: "same" }));

  const failure = await failureOf(async () => {
    for await (const entry of storage().list()) void entry;
  });

  expect(failure).toMatchObject({ code: "ProviderError", operation: "list" });
  expect(failure.message).toContain("the page token it was sent");
  expect(sent).toHaveLength(2);
});

test("a signal that already fired rejects the listing with `AbortError` before any request", async () => {
  const sent = stubFetch(() => listingAnswer());

  const failure = await storage()
    .list({ signal: AbortSignal.abort() })
    .page()
    .catch((reason: unknown) => reason);

  expect(failure).toMatchObject({ name: "AbortError" });
  expect(sent).toEqual([]);
});

// Refusals of `list`, `copy` and `move` before any request

test.each([[0], [1001], [2.5]])(
  "a `pageSize` of %d is `InvalidOption` from `page()`, and `list` itself sends nothing",
  async (pageSize) => {
    const sent = stubFetch(() => resource());
    const listing = storage().list({ pageSize });

    const failure = await failureOf(() => listing.page());

    expect(failure).toMatchObject({ code: "InvalidOption", operation: "list", attempts: 0 });
    expect(failure.message).toContain("`pageSize`");
    expect(sent).toEqual([]);
  },
);

test("iterating a listing meets the same refusal", async () => {
  const listing = storage().list({ pageSize: 0 });

  const failure = await failureOf(async () => {
    for await (const entry of listing) return entry;

    return undefined;
  });

  expect(failure).toMatchObject({ code: "InvalidOption", operation: "list" });
});

test("an unknown option and an empty delimiter of `list` are `InvalidOption` naming them", async () => {
  // oxlint-disable-next-line no-unsafe-type-assertion -- a caller written in JavaScript
  const unknown = { recursive: true } as ListOptions;

  expect((await failureOf(() => storage().list(unknown).page())).message).toContain("`recursive`");
  expect((await failureOf(() => storage().list({ delimiter: "" }).page())).message).toContain(
    "`delimiter`",
  );
});

test("a prefix the core rule refuses is `InvalidKey`", async () => {
  const failure = await failureOf(() => storage().list({ prefix: "a/../b" }).page());

  expect(failure).toMatchObject({ code: "InvalidKey", operation: "list", attempts: 0 });
});

test.each([["copy"], ["move"]] as const)(
  "`%s` of a key onto itself is `InvalidRequest` before any request",
  async (operation) => {
    const sent = stubFetch(() => resource());

    const failure = await failureOf(() => storage()[operation]("object", "object"));

    expect(failure).toMatchObject({
      code: "InvalidRequest",
      operation,
      key: "object",
      attempts: 0,
    });
    expect(sent).toEqual([]);
  },
);

test.each([["copy"], ["move"]] as const)(
  "`%s` checks both keys before acting on either",
  async (operation) => {
    const refusedSource = await failureOf(() => storage()[operation]("a/../b", "object"));
    const refusedDestination = await failureOf(() =>
      storage()[operation]("object", ".well-known/acme-challenge/token"),
    );

    expect(refusedSource).toMatchObject({ code: "InvalidKey", key: "a/../b", operation });
    expect(refusedDestination).toMatchObject({
      code: "InvalidKey",
      key: ".well-known/acme-challenge/token",
      operation,
    });
  },
);

test("any `401` to the repeat says that the token expired or is not accepted", async () => {
  const answers = [invalidToken(), errorDocument(401, "required", "Login Required.")];
  const sent = stubFetch(() => answers.shift() ?? resource());

  const failure = await failureOf(() => storage().stat("object"));

  expect(sent).toHaveLength(2);
  expect(failure).toMatchObject({
    code: "InvalidCredentials",
    attempts: 2,
    providerCode: "required",
  });
  expect(failure.message).toContain("expired or is not accepted");
});
