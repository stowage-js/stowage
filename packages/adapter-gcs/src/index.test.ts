import {
  isStorageError,
  type ListOptions,
  type OperationOptions,
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
  return Response.json(resourceFields(fields));
}

function resourceFields(fields: Record<string, unknown> = {}): Record<string, unknown> {
  return {
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
  };
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

// Until the adapter declares `contentHeaders`, spec 4.3 refuses the three before any check
// of their form, `""` included.
test.each([
  ["cacheControl", "public, max-age=60"],
  ["contentDisposition", "attachment"],
  ["contentLanguage", "de-AT"],
  ["cacheControl", ""],
])(
  "`%s` as %j is `Unsupported` naming `contentHeaders` before any request",
  async (option, value) => {
    const sent = stubFetch(() => resource());

    const failure = await failureOf(() => storage().put("object", "hello", { [option]: value }));

    expect(failure).toMatchObject({
      code: "Unsupported",
      capability: "contentHeaders",
      operation: "put",
      key: "object",
      attempts: 0,
    });
    expect(sent).toEqual([]);
  },
);

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

// Ranges

const rangedBody = "0123456789";

/** Answers `get` as GCS answers a range it honored: `206` and the bytes the range names. */
function storedRanged(request: SentRequest): Response {
  if (!request.url.includes("alt=media")) return resource({ size: String(rangedBody.length) });

  const [, start = "0", end = String(rangedBody.length - 1)] =
    /^bytes=(\d+)-(\d*)$/u.exec(request.headers.get("range") ?? "") ?? [];

  return new Response(rangedBody.slice(Number(start), Number(end || rangedBody.length) + 1), {
    status: 206,
    headers: { "content-range": `bytes ${start}-${end}/${rangedBody.length}` },
  });
}

test("a range goes to the media download alone, as the `Range` field", async () => {
  const sent = stubFetch(storedRanged);

  await storage().get("object", { range: { start: 2, end: 5 } });

  const [described, download] = sent.toSorted(byUrl);

  expect(described?.headers.has("range")).toBe(false);
  expect(download?.headers.get("range")).toBe("bytes=2-5");
});

test("a ranged `get` reads the range and describes the whole object", async () => {
  stubFetch(storedRanged);

  const read = await storage().get("object", { range: { start: 2, end: 5 } });

  expect(read.stat.size).toBe(10);
  expect(await read.text()).toBe("2345");
});

test("a range without an end reads to the end of the object", async () => {
  const sent = stubFetch(storedRanged);

  const read = await storage().get("object", { range: { start: 7 } });

  expect(sent.find((request) => request.url.includes("alt=media"))?.headers.get("range")).toBe(
    "bytes=7-",
  );
  expect(await read.text()).toBe("789");
});

test.each([[{ start: -1 }], [{ start: 1.5 }], [{ start: 5, end: 4 }]])(
  "the range %j is `InvalidOption` before any request",
  async (range) => {
    const sent = stubFetch(storedRanged);

    const failure = await failureOf(() => storage().get("object", { range }));

    expect(failure).toMatchObject({ code: "InvalidOption", operation: "get", attempts: 0 });
    expect(failure.message).toContain("`range`");
    expect(sent).toEqual([]);
  },
);

test("a `200` answering a range that covers the object is the body asked for", async () => {
  stubFetch(stored(rangedBody));

  const read = await storage().get("object", { range: { start: 0, end: 40 } });

  expect(await read.text()).toBe(rangedBody);
});

test("a `200` answering a range that covers less is a `ProviderError`, its body canceled", async () => {
  const cancel = vi.fn<() => void>();

  stubFetch((request) =>
    request.url.includes("alt=media")
      ? new Response(new ReadableStream({ cancel }), { status: 200 })
      : resource({ size: String(rangedBody.length) }),
  );

  const failure = await failureOf(() => storage().get("object", { range: { start: 2 } }));

  expect(failure).toMatchObject({ code: "ProviderError", key: "object", attempts: 1 });
  expect(cancel).toHaveBeenCalledOnce();
});

test("a media `416` is `InvalidRequest` naming the size the resource answered with", async () => {
  const downloadFailed = Promise.withResolvers<void>();

  stubFetch(async (request) => {
    if (request.url.includes("alt=media")) {
      downloadFailed.resolve();

      return new Response("The requested range cannot be satisfied.", {
        status: 416,
        headers: { "x-guploader-uploadid": "upload-416" },
      });
    }

    // The resource answers only once the download's failure had time to reach `get`, and
    // a `get` that aborted the resource request on that failure never sees the answer.
    await downloadFailed.promise;
    await new Promise((resolve) => setTimeout(resolve, 5));
    request.signal?.throwIfAborted();

    return resource({ size: String(rangedBody.length) });
  });

  const failure = await failureOf(() => storage().get("object", { range: { start: 10 } }));

  expect(failure).toMatchObject({
    code: "InvalidRequest",
    operation: "get",
    key: "object",
    status: 416,
    attempts: 1,
    requestId: "upload-416",
    message: 'The range starts beyond the 10 bytes under the key "object"',
  });
  expect(failure.providerCode).toBeUndefined();
});

test("a media `416` is `InvalidRequest` when the resource size leaves room for the range", async () => {
  stubFetch((request) =>
    request.url.includes("alt=media")
      ? Response.json(
          {
            error: {
              message: "The requested range cannot be satisfied.",
              errors: [{ reason: "unexpectedReason" }],
            },
          },
          { status: 416, headers: { "x-guploader-uploadid": "upload-416" } },
        )
      : resource({ size: String(rangedBody.length) }),
  );

  const failure = await failureOf(() => storage().get("object", { range: { start: 2 } }));

  expect(failure).toMatchObject({
    code: "InvalidRequest",
    operation: "get",
    key: "object",
    status: 416,
    attempts: 1,
    requestId: "upload-416",
    message: "The requested range cannot be satisfied.",
  });
  expect(failure.providerCode).toBeUndefined();
});

test("a media `416` beside a failed resource request reports the resource's failure", async () => {
  stubFetch((request) =>
    request.url.includes("alt=media") ? new Response("", { status: 416 }) : notFound(),
  );

  const failure = await failureOf(() => storage().get("absent", { range: { start: 10 } }));

  expect(failure).toMatchObject({ code: "NotFound", key: "absent", status: 404 });
});

// One of the two requests of `get` failing (spec 9.8)

test("a failed media download aborts the resource request beside it, and is reported", async () => {
  let described: SentRequest | undefined;

  stubFetch(async (request) => {
    if (isMedia(request)) return textAnswer(403, "Access denied.", "text/plain");

    described = request;

    return await new Promise<Response>((_, reject) => {
      request.signal?.addEventListener("abort", () => reject(request.signal?.reason));
    });
  });

  const failure = await failureOf(() => storage().get("object"));

  expect(failure).toMatchObject({ code: "AccessDenied", key: "object", status: 403, attempts: 1 });
  expect(described?.signal?.aborted).toBe(true);
});

test("`attempts` counts the requests of the one whose failure is reported", async () => {
  vi.spyOn(Math, "random").mockReturnValue(0);

  const sent = stubFetch((request) =>
    isMedia(request) ? textAnswer(503, "Service Unavailable", "text/plain") : resource(),
  );

  const failure = await failureOf(() => storage().get("object"));

  expect(failure).toMatchObject({ code: "ProviderError", status: 503, attempts: 3 });
  expect(sent.filter((request) => isMedia(request))).toHaveLength(3);
});

// A replaced generation (spec 9.4, ADR 0040)

const firstGeneration = "1790665923456000";
const laterGeneration = "1790665987654000";

/** A media download of `body`, as GCS answers it for the generation it names. */
function mediaOf(
  body: BodyInit,
  generation: string,
  init: { readonly status?: number; readonly headers?: Record<string, string> } = {},
): Response {
  return new Response(body, {
    status: init.status ?? 200,
    headers: { "content-type": "text/plain", "x-goog-generation": generation, ...init.headers },
  });
}

/** The generation the request is pinned to, where it is pinned to one. */
function pinnedGeneration(request: SentRequest): string | null {
  return new URL(request.url).searchParams.get("generation");
}

function isPinned(request: SentRequest, generation: string): boolean {
  return pinnedGeneration(request) === generation;
}

function isMedia(request: SentRequest): boolean {
  return new URL(request.url).searchParams.get("alt") === "media";
}

/**
 * Answers `get` as GCS does where a writer replaced the object between its two requests:
 * the resource names `firstGeneration`, and the media download the one after it.
 */
function replacedBetween(
  pinned: (request: SentRequest) => Response,
  firstBody: BodyInit = "hello, world",
) {
  return (request: SentRequest): Response => {
    if (pinnedGeneration(request) !== null) return pinned(request);

    return isMedia(request)
      ? mediaOf(firstBody, laterGeneration)
      : resource({ size: "5", generation: firstGeneration });
  };
}

test("where the two name different generations, the resource of the body's generation describes it", async () => {
  const sent = stubFetch(
    replacedBetween(() =>
      resource({ size: "12", generation: laterGeneration, contentType: "text/markdown" }),
    ),
  );

  const read = await storage().get("object");

  expect(read.stat).toMatchObject({ size: 12, contentType: "text/markdown" });
  expect(await read.text()).toBe("hello, world");

  const pinned = sent.filter((request) => pinnedGeneration(request) !== null);

  expect(pinned.map((request) => request.url)).toEqual([
    `https://storage.googleapis.com/storage/v1/b/conformance/o/object?generation=${laterGeneration}`,
  ]);
  expect(sent).toHaveLength(3);
});

test.each([
  ["above", "1790665999999999"],
  ["below", "1790665000000000"],
])(
  "the resource is read again first where the body's generation is numerically %s the resource's",
  async (_, bodyGeneration) => {
    const sent = stubFetch((request) => {
      if (isPinned(request, bodyGeneration)) {
        return resource({ size: "12", generation: bodyGeneration });
      }

      return isMedia(request)
        ? mediaOf("hello, world", bodyGeneration)
        : resource({ size: "5", generation: firstGeneration });
    });

    const read = await storage().get("object");

    expect(read.stat.size).toBe(12);
    expect(await read.text()).toBe("hello, world");
    expect(sent.filter((request) => isPinned(request, bodyGeneration))).toHaveLength(1);
    expect(sent.filter((request) => isPinned(request, firstGeneration))).toEqual([]);
  },
);

test("where the body's generation is gone, the body is canceled and the first resource's generation downloaded, with the range", async () => {
  const cancel = vi.fn<() => void>();
  const sent = stubFetch((request) => {
    if (isPinned(request, laterGeneration)) return notFound();

    if (isPinned(request, firstGeneration)) {
      return mediaOf("2345", firstGeneration, {
        status: 206,
        headers: { "content-range": "bytes 2-5/10" },
      });
    }

    return isMedia(request)
      ? mediaOf(new ReadableStream({ cancel }), laterGeneration, { status: 206 })
      : resource({ size: "10", generation: firstGeneration });
  });

  const read = await storage().get("object", { range: { start: 2, end: 5 } });

  expect(cancel).toHaveBeenCalledOnce();
  expect(read.stat.size).toBe(10);
  expect(await read.text()).toBe("2345");

  const download = sent.find((request) => isPinned(request, firstGeneration));

  expect(download?.url).toBe(
    `https://storage.googleapis.com/storage/v1/b/conformance/o/object?alt=media&generation=${firstGeneration}`,
  );
  expect(download?.headers.get("range")).toBe("bytes=2-5");
  expect(sent).toHaveLength(4);
});

test("where both generations are gone, `get` is `NotFound` naming the key, the message word for word", async () => {
  const sent = stubFetch(
    replacedBetween((request) =>
      isMedia(request) ? textAnswer(404, "No such object: conformance/object") : notFound(),
    ),
  );

  const failure = await failureOf(() => storage().get("object"));

  expect(failure).toMatchObject({
    code: "NotFound",
    key: "object",
    operation: "get",
    status: 404,
    message: "No such object: conformance/object",
  });
  expect(sent).toHaveLength(4);
});

test("a pinned request is repeated on a budget of its own, and its failure cancels the kept body", async () => {
  vi.spyOn(Math, "random").mockReturnValue(0);

  const cancel = vi.fn<() => void>();
  const sent = stubFetch(
    replacedBetween(
      () => errorDocument(503, "backendError", "Backend Error"),
      new ReadableStream({ cancel }),
    ),
  );

  const failure = await failureOf(() => storage().get("object"));

  expect(failure).toMatchObject({ code: "ProviderError", status: 503, attempts: 3 });
  expect(sent.filter((request) => isPinned(request, laterGeneration))).toHaveLength(3);
  expect(cancel).toHaveBeenCalledOnce();
});

test("the caller's abort between two requests rejects with `AbortError` and cancels the kept body", async () => {
  const controller = new AbortController();
  const cancel = vi.fn<() => void>();

  stubFetch(
    replacedBetween(() => {
      controller.abort();

      throw controller.signal.reason;
    }, new ReadableStream({ cancel })),
  );

  await expect(storage().get("object", { signal: controller.signal })).rejects.toMatchObject({
    name: "AbortError",
  });
  expect(cancel).toHaveBeenCalledOnce();
});

test("a media download that names no generation is kept with the resource beside it", async () => {
  const sent = stubFetch((request) =>
    isMedia(request) ? new Response("hello") : resource({ generation: firstGeneration }),
  );

  const read = await storage().get("object");

  expect(await read.text()).toBe("hello");
  expect(sent).toHaveLength(2);
});

// A stored content coding (spec 9.4, ADR 0040)

const decodedBody = "x".repeat(1000);

/** Answers `get` for an object another tool stored gzipped, decoded on the way out. */
function storedGzipped(body: BodyInit = decodedBody, status = 200) {
  return (request: SentRequest): Response =>
    isMedia(request)
      ? mediaOf(body, firstGeneration, {
          status,
          headers: { "x-goog-stored-content-encoding": "gzip" },
        })
      : resource({ size: "39", generation: firstGeneration, contentEncoding: "gzip" });
}

test("an object stored with a content coding is read decoded, its `size` the stored size", async () => {
  stubFetch(storedGzipped());

  const read = await storage().get("object");

  expect(read.stat.size).toBe(39);
  expect(await read.bytes()).toHaveLength(1000);
});

test.each([
  [{ start: 0 }],
  [{ start: 0, end: 38 }],
  [{ start: 0, end: 5000 }],
  [{ start: 2, end: 5 }],
  [{ start: 100 }],
])(
  "the range %j on an object stored gzipped is a `ProviderError` naming the coding",
  async (range) => {
    const cancel = vi.fn<() => void>();

    stubFetch(storedGzipped(new ReadableStream({ cancel })));

    const failure = await failureOf(() => storage().get("object", { range }));

    expect(failure).toMatchObject({ code: "ProviderError", key: "object", operation: "get" });
    expect(failure.message).toContain('"gzip"');
    expect(cancel).toHaveBeenCalledOnce();
  },
);

test("a range the provider honored on an object stored gzipped is refused as well", async () => {
  const cancel = vi.fn<() => void>();

  stubFetch(storedGzipped(new ReadableStream({ cancel }), 206));

  const failure = await failureOf(() => storage().get("object", { range: { start: 2, end: 5 } }));

  expect(failure).toMatchObject({ code: "ProviderError", status: 206 });
  expect(cancel).toHaveBeenCalledOnce();
});

test("a media `416` on an object stored gzipped is the `ProviderError` naming the coding", async () => {
  stubFetch((request) =>
    isMedia(request)
      ? new Response("The requested range cannot be satisfied.", { status: 416 })
      : resource({ size: "39", contentEncoding: "gzip" }),
  );

  const failure = await failureOf(() => storage().get("object", { range: { start: 100 } }));

  expect(failure).toMatchObject({ code: "ProviderError", status: 416 });
  expect(failure.message).toContain('"gzip"');
});

test("the coding is read off the media download where the resource names none", async () => {
  stubFetch((request) =>
    isMedia(request)
      ? mediaOf(decodedBody, firstGeneration, {
          headers: { "x-goog-stored-content-encoding": "br" },
        })
      : resource({ size: "39", generation: firstGeneration }),
  );

  const failure = await failureOf(() => storage().get("object", { range: { start: 0 } }));

  expect(failure).toMatchObject({ code: "ProviderError" });
  expect(failure.message).toContain('"br"');
});

test("`identity`, which GCS sends for an object stored without a coding, leaves a range honored", async () => {
  stubFetch((request) =>
    isMedia(request)
      ? mediaOf("2345", firstGeneration, {
          status: 206,
          headers: { "x-goog-stored-content-encoding": "identity" },
        })
      : resource({ size: "10", generation: firstGeneration }),
  );

  const read = await storage().get("object", { range: { start: 2, end: 5 } });

  expect(await read.text()).toBe("2345");
});

test("no request of the adapter sends `Content-Encoding`", async () => {
  const sent = stubFetch((request) => {
    if (request.method === "POST" && request.url.includes("/batch/")) {
      return new Response("", { status: 200, headers: { "content-type": "multipart/mixed" } });
    }

    if (request.method === "GET" && new URL(request.url).pathname.endsWith("/o")) {
      return Response.json({ items: [] });
    }

    return isMedia(request) ? media("hello") : resource();
  });

  await storage().put("object", "hello");
  await storage()
    .get("object", { range: { start: 1 } })
    .catch(() => {});
  await storage().stat("object");
  await storage().list().page();
  await storage()
    .delete("object")
    .catch(() => {});

  expect(sent.length).toBeGreaterThanOrEqual(5);
  expect(sent.filter((request) => request.headers.has("content-encoding"))).toEqual([]);
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
    isMedia(request)
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
    isMedia(request) ? textAnswer(403, "A &#0; B &#xD800; C &nbsp; D &") : resource(),
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
    isMedia(request)
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
  stubFetch((request) => (isMedia(request) ? textAnswer(404, missingBucket) : resource()));

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

    return isMedia(request)
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

interface Subanswer {
  readonly status: number;
  readonly body?: string;
}

const deleted: Subanswer = { status: 204 };

function subanswerOf(status: number, providerCode: string, message: string): Subanswer {
  return {
    status,
    body: JSON.stringify({
      error: {
        code: status,
        message,
        errors: [{ message, domain: "global", reason: providerCode }],
      },
    }),
  };
}

const absent = subanswerOf(404, "notFound", "No such object: conformance/absent");

/**
 * A batch answered as GCS answers one: lines ending in LF, each bare `Content-ID` echoed
 * behind `response-`, and the outer answer alone carrying `x-guploader-uploadid`. Measured
 * against the bucket by the first scheduled run (#256).
 */
function batchAnswer(
  subanswers: readonly Subanswer[],
  echo: (place: number) => string = (place) => `response-${place}`,
): Response {
  const boundary = "batch_pK7JBAk73-E=_AA5eFwv4m2Q=";
  const parts = subanswers.map(
    ({ status, body }, place) =>
      `--${boundary}\n` +
      "Content-Type: application/http\n" +
      `Content-ID: ${echo(place)}\n\n` +
      `HTTP/1.1 ${status} Status\n` +
      (body === undefined
        ? "Content-Length: 0\n\n\n"
        : `Content-Type: application/json\n\n${body}\n`),
  );

  return new Response(`${parts.join("")}--${boundary}--\n`, {
    status: 200,
    headers: {
      "content-type": `multipart/mixed; boundary=${boundary}`,
      "x-guploader-uploadid": "batch-1",
    },
  });
}

/** Answers every subrequest of a batch alike. */
function everyKey(subanswer: Subanswer) {
  return async (request: SentRequest): Promise<Response> =>
    batchAnswer(subrequestPathsOf(await bodyText(request.body)).map(() => subanswer));
}

function subrequestPathsOf(body: string): readonly string[] {
  return [...body.matchAll(/^DELETE (\S+) HTTP\/1\.1\r$/gmu)].map((match) => match[1] ?? "");
}

test("`delete` of no key resolves with `requested: 0` and sends nothing", async () => {
  const sent = stubFetch(() => batchAnswer([]));

  expect(await storage().delete()).toEqual({ requested: 0, failed: [] });
  expect(sent).toEqual([]);
});

test("`delete` sends its keys as one batch of `DELETE`s to the batch endpoint", async () => {
  const sent = stubFetch(everyKey(deleted));

  const report = await storage().delete("a/b", "c d");

  expect(report).toEqual({ requested: 2, failed: [] });
  expect(sent).toHaveLength(1);
  expect(sent[0]?.method).toBe("POST");
  expect(sent[0]?.url).toBe("https://storage.googleapis.com/batch/storage/v1");
  expect(sent[0]?.headers.get("authorization")).toBe(`Bearer ${accessToken}`);
  expect(sent[0]?.headers.get("content-type")).toMatch(/^multipart\/mixed; boundary=/u);
  expect(subrequestPathsOf(await bodyText(sent[0]?.body))).toEqual([
    "/storage/v1/b/conformance/o/a%2Fb",
    "/storage/v1/b/conformance/o/c%20d",
  ]);
});

test("`delete` sends one batch per 100 keys, one after another", async () => {
  const sent = stubFetch(everyKey(deleted));
  const keys = Array.from({ length: 250 }, (_, index) => `key-${index}`);

  const report = await storage().delete(...keys);

  expect(report).toEqual({ requested: 250, failed: [] });
  expect(
    await Promise.all(
      sent.map(async (request) => subrequestPathsOf(await bodyText(request.body)).length),
    ),
  ).toEqual([100, 100, 50]);
});

test("an invalid key is reported as `InvalidKey` without being sent, and the others are deleted", async () => {
  const sent = stubFetch(everyKey(deleted));

  const report = await storage().delete("one", "a/../b", "two");

  expect(report.requested).toBe(3);
  expect(report.failed).toHaveLength(1);
  expect(report.failed[0]).toMatchObject({
    code: "InvalidKey",
    key: "a/../b",
    operation: "delete",
    attempts: 0,
  });
  expect(subrequestPathsOf(await bodyText(sent[0]?.body))).toEqual([
    "/storage/v1/b/conformance/o/one",
    "/storage/v1/b/conformance/o/two",
  ]);
});

test("a writable-only refusal does not hold up `delete`, which addresses an existing name", async () => {
  const sent = stubFetch(everyKey(deleted));

  const report = await storage().delete(".well-known/acme-challenge/token");

  expect(report).toEqual({ requested: 1, failed: [] });
  expect(sent).toHaveLength(1);
});

test("a mixed answer: `404 notFound` counts as deleted, any other failure is the key's entry", async () => {
  const sent = stubFetch(() =>
    batchAnswer([
      deleted,
      absent,
      subanswerOf(403, "forbidden", "Caller does not have storage.objects.delete access."),
      subanswerOf(503, "backendError", "Backend Error"),
    ]),
  );

  const report = await storage().delete("one", "absent", "denied", "busy");

  expect(sent).toHaveLength(1);
  expect(report.requested).toBe(4);
  expect(report.failed).toHaveLength(2);
  expect(report.failed[0]).toMatchObject({
    code: "AccessDenied",
    key: "denied",
    operation: "delete",
    status: 403,
    providerCode: "forbidden",
    requestId: "batch-1",
    attempts: 1,
    retryable: false,
    message: "Caller does not have storage.objects.delete access.",
  });
  expect(report.failed[1]).toMatchObject({
    code: "ProviderError",
    key: "busy",
    status: 503,
    requestId: "batch-1",
    retryable: true,
  });
});

test("a key above 1024 bytes answered `404 notFound` counts as deleted", async () => {
  stubFetch(everyKey(absent));

  expect(await storage().delete("k".repeat(1025))).toEqual({ requested: 1, failed: [] });
});

test("a subresponse's `404` without `notFound` is the key's `ProviderError`, not a deletion", async () => {
  stubFetch(everyKey({ status: 404, body: "Not Found" }));

  const report = await storage().delete("object");

  expect(report.failed[0]).toMatchObject({ code: "ProviderError", key: "object", status: 404 });
  expect(report.failed[0]?.message).toContain("serves no such path");
});

test("a missing bucket rejects the whole call with `NotFound` naming no key", async () => {
  stubFetch(everyKey(subanswerOf(404, "notFound", "The specified bucket does not exist.")));

  const failure = await failureOf(() => storage().delete("one", "two"));

  expect(failure).toMatchObject({
    code: "NotFound",
    operation: "delete",
    status: 404,
    providerCode: "notFound",
    requestId: "batch-1",
  });
  expect(failure.key).toBeUndefined();
});

test("an answer the reader cannot read is a `ProviderError` of the whole call", async () => {
  stubFetch(() => Response.json({}, { headers: { "x-guploader-uploadid": "batch-1" } }));

  const failure = await failureOf(() => storage().delete("one"));

  expect(failure).toMatchObject({
    code: "ProviderError",
    operation: "delete",
    status: 200,
    requestId: "batch-1",
  });
  expect(failure.message).toContain("no batch of responses");
});

test("a key the answer leaves unanswered is a `ProviderError` naming it", async () => {
  stubFetch(() => batchAnswer([deleted]));

  const failure = await failureOf(() => storage().delete("one", "two"));

  expect(failure).toMatchObject({ code: "ProviderError", operation: "delete" });
  expect(failure.message).toContain('"two"');
});

test("a `Content-ID` echoed as sent, as fake-gcs-server echoes it, is read as well", async () => {
  stubFetch(() => batchAnswer([absent, subanswerOf(403, "forbidden", "Forbidden")], String));

  const report = await storage().delete("absent", "denied");

  expect(report.failed.map(({ code, key }) => [code, key])).toEqual([["AccessDenied", "denied"]]);
});

// GCS answers `<response-0>` to `<0>` alone, which the adapter never sends.
test("a `Content-ID` echoed in brackets is a `ProviderError`", async () => {
  stubFetch(() => batchAnswer([deleted], (place) => `<response-${place}>`));

  const failure = await failureOf(() => storage().delete("one"));

  expect(failure).toMatchObject({ code: "ProviderError", operation: "delete" });
  expect(failure.message).toContain('unexpected Content-ID "<response-0>"');
});

test("a failed batch as a whole is repeated on the budget and then rejects the call", async () => {
  const sent = stubFetch(() => errorDocument(503, "backendError", "Backend Error"));

  const failure = await failureOf(() => storage({ retry: { maxAttempts: 2 } }).delete("one"));

  expect(sent).toHaveLength(2);
  expect(failure).toMatchObject({
    code: "ProviderError",
    operation: "delete",
    status: 503,
    attempts: 2,
    retryable: true,
  });
});

test("`deleteAll` lists the prefix a page at a time and deletes each page as it arrives", async () => {
  const sent = stubFetch(async (request) => {
    if (request.method === "POST") return await everyKey(deleted)(request);

    return new URL(request.url).searchParams.get("pageToken") === "second"
      ? listingAnswer({ items: [listed("docs/c.txt")] })
      : listingAnswer({
          items: [listed("docs/a.txt"), listed("docs/b.txt")],
          nextPageToken: "second",
        });
  });

  const report = await storage().deleteAll("docs/");

  expect(report).toEqual({ requested: 3, failed: [] });
  expect(sent.map((request) => request.method)).toEqual(["GET", "POST", "GET", "POST"]);
  expect(new URL(sent[0]!.url).searchParams.get("maxResults")).toBe("1000");
  expect(new URL(sent[0]!.url).searchParams.get("prefix")).toBe("docs/");
  expect(new URL(sent[2]!.url).searchParams.get("maxResults")).toBe("1000");
  expect(subrequestPathsOf(await bodyText(sent[3]?.body))).toEqual([
    "/storage/v1/b/conformance/o/docs%2Fc.txt",
  ]);
});

test("`deleteAll` reports what it could not delete, told against `deleteAll`", async () => {
  stubFetch((request) =>
    request.method === "POST"
      ? batchAnswer([deleted, subanswerOf(403, "forbidden", "Forbidden")])
      : listingAnswer({ items: [listed("a"), listed("b")] }),
  );

  const report = await storage().deleteAll("");

  expect(report.requested).toBe(2);
  expect(report.failed.map(({ code, key, operation }) => [code, key, operation])).toEqual([
    ["AccessDenied", "b", "deleteAll"],
  ]);
});

test("`deleteAll` below an empty prefix lists once and sends no batch", async () => {
  const sent = stubFetch(() => listingAnswer());

  expect(await storage().deleteAll("empty/")).toEqual({ requested: 0, failed: [] });
  expect(sent).toHaveLength(1);
});

test("`deleteAll` refuses a prefix, an unknown option and a fired signal before any request", async () => {
  const sent = stubFetch(() => listingAnswer());

  // oxlint-disable-next-line no-unsafe-type-assertion -- the point of the test
  const options = { pageSize: 5 } as OperationOptions;

  const refusedPrefix = await failureOf(() => storage().deleteAll("a/../b"));
  const unknownOption = await failureOf(() => storage().deleteAll("a/", options));
  const aborted = await storage()
    .deleteAll("a/", { signal: AbortSignal.abort() })
    .catch((reason: unknown) => reason);

  expect(refusedPrefix).toMatchObject({ code: "InvalidKey", operation: "deleteAll" });
  expect(unknownOption).toMatchObject({ code: "InvalidOption", operation: "deleteAll" });
  expect(aborted).toMatchObject({ name: "AbortError" });
  expect(sent).toEqual([]);
});

// `copy` (spec 9.7, ADR 0037)

const rewriteUrl =
  "https://storage.googleapis.com/storage/v1/b/conformance/o/from%2Fa.txt/rewriteTo/b/conformance/o/to%2Fb.txt";

/** An answer of `rewriteTo` that leaves the rewrite unfinished, as the spike measured at 12 GiB. */
function rewriteInProgress(rewriteToken: string): Response {
  return Response.json({
    kind: "storage#rewriteResponse",
    totalBytesRewritten: "9873391616",
    objectSize: "12884901888",
    done: false,
    rewriteToken,
  });
}

/** The answer of `rewriteTo` that finishes the rewrite and carries the destination's resource. */
function rewriteDone(fields: Record<string, unknown> = {}): Response {
  return Response.json({
    kind: "storage#rewriteResponse",
    totalBytesRewritten: "5",
    objectSize: "5",
    done: true,
    resource: resourceFields({ name: "to/b.txt", ...fields }),
  });
}

function backendError(): Response {
  return errorDocument(503, "backendError", "Backend Error");
}

test("`copy` sends one `rewriteTo` without a body and nothing in front of it", async () => {
  const sent = stubFetch(() => rewriteDone());

  await storage().copy("from/a.txt", "to/b.txt");

  expect(sent).toHaveLength(1);
  expect(sent[0]?.method).toBe("POST");
  expect(sent[0]?.url).toBe(rewriteUrl);
  expect(sent[0]?.body).toBeUndefined();
  expect(sent[0]?.headers.get("authorization")).toBe(`Bearer ${accessToken}`);
});

test("`copy` resolves with the destination the finishing answer carries", async () => {
  stubFetch(() =>
    rewriteDone({ size: "11", contentType: "text/markdown", metadata: { writtenby: "stowage" } }),
  );

  const written = await storage().copy("from/a.txt", "to/b.txt");

  expect(written).toMatchObject({
    key: "to/b.txt",
    size: 11,
    contentType: "text/markdown",
    userMetadata: { writtenby: "stowage" },
  });
});

test("`copy` carries each answer's token to the next call until the rewrite is done", async () => {
  const answers = [rewriteInProgress("token-1"), rewriteInProgress("token-2"), rewriteDone()];
  const sent = stubFetch(() => answers.shift() ?? rewriteDone());

  const written = await storage().copy("from/a.txt", "to/b.txt");

  expect(sent.map((request) => request.url)).toEqual([
    rewriteUrl,
    `${rewriteUrl}?rewriteToken=token-1`,
    `${rewriteUrl}?rewriteToken=token-2`,
  ]);
  expect(written.key).toBe("to/b.txt");
});

test("a `404` on a continued call is `NotFound` naming the source, the message word for word", async () => {
  const replaced = "No such object: conformance/from/a.txt";
  const answers = [rewriteInProgress("token-1"), errorDocument(404, "notFound", replaced)];

  stubFetch(() => answers.shift() ?? rewriteDone());

  const failure = await failureOf(() => storage().copy("from/a.txt", "to/b.txt"));

  expect(failure).toMatchObject({
    code: "NotFound",
    operation: "copy",
    key: "from/a.txt",
    message: replaced,
    status: 404,
    attempts: 1,
  });
});

test("a missing source is `NotFound` naming it, and a missing bucket `NotFound` without a key", async () => {
  const answers = [notFound(), errorDocument(404, "notFound", missingBucket)];

  stubFetch(() => answers.shift() ?? rewriteDone());

  const missingSource = await failureOf(() => storage().copy("from/a.txt", "to/b.txt"));
  const missingBucketFailure = await failureOf(() => storage().copy("from/a.txt", "to/b.txt"));

  expect(missingSource).toMatchObject({ code: "NotFound", operation: "copy", key: "from/a.txt" });
  expect(missingBucketFailure).toMatchObject({ code: "NotFound", operation: "copy" });
  expect(missingBucketFailure.key).toBeUndefined();
});

test("each call of the rewrite is repeated as sent, on a budget of its own", async () => {
  vi.spyOn(Math, "random").mockReturnValue(0);

  const answers = [
    backendError(),
    backendError(),
    rewriteInProgress("token-1"),
    backendError(),
    backendError(),
    rewriteDone(),
  ];
  const sent = stubFetch(() => answers.shift() ?? rewriteDone());

  await storage().copy("from/a.txt", "to/b.txt");

  expect(sent.map((request) => request.url)).toEqual([
    rewriteUrl,
    rewriteUrl,
    rewriteUrl,
    `${rewriteUrl}?rewriteToken=token-1`,
    `${rewriteUrl}?rewriteToken=token-1`,
    `${rewriteUrl}?rewriteToken=token-1`,
  ]);
});

test("the caller's abort between two calls rejects with `AbortError` and sends no further call", async () => {
  const controller = new AbortController();
  const sent = stubFetch(() => {
    controller.abort();

    return rewriteInProgress("token-1");
  });

  await expect(
    storage().copy("from/a.txt", "to/b.txt", { signal: controller.signal }),
  ).rejects.toMatchObject({ name: "AbortError" });
  expect(sent).toHaveLength(1);
});

test("the signal reaches every call of the rewrite", async () => {
  const controller = new AbortController();
  const answers = [rewriteInProgress("token-1"), rewriteDone()];
  const sent = stubFetch(() => answers.shift() ?? rewriteDone());

  await storage().copy("from/a.txt", "to/b.txt", { signal: controller.signal });

  expect(sent.map((request) => request.signal)).toEqual([controller.signal, controller.signal]);
});

test("a signal that already fired rejects `copy` before any request", async () => {
  const sent = stubFetch(() => rewriteDone());

  const failure = await storage()
    .copy("from/a.txt", "to/b.txt", { signal: AbortSignal.abort() })
    .catch((reason: unknown) => reason);

  expect(failure).toMatchObject({ name: "AbortError" });
  expect(sent).toEqual([]);
});

test.each([
  ["a finished rewrite without the object", { done: true }],
  ["an unfinished rewrite without a token", { done: false }],
])("%s is a `ProviderError`, not a copy made up", async (_, answer) => {
  stubFetch(() => Response.json({ kind: "storage#rewriteResponse", ...answer }));

  const failure = await failureOf(() => storage().copy("from/a.txt", "to/b.txt"));

  expect(failure).toMatchObject({ code: "ProviderError", operation: "copy", status: 200 });
});

// `move` (spec 9.5, 9.7, ADR 0037)

const moveUrl =
  "https://storage.googleapis.com/storage/v1/b/conformance/o/from%2Fa.txt/moveTo/o/to%2Fb.txt";

function moved(fields: Record<string, unknown> = {}): Response {
  return resource({ name: "to/b.txt", ...fields });
}

function transportFailure(): never {
  throw new TypeError("fetch failed");
}

test("`move` sends one `objects.move` without a body and resolves with the destination", async () => {
  const sent = stubFetch(() => moved({ size: "11", metadata: { writtenby: "stowage" } }));

  const written = await storage().move("from/a.txt", "to/b.txt");

  expect(sent).toHaveLength(1);
  expect(sent[0]?.method).toBe("POST");
  expect(sent[0]?.url).toBe(moveUrl);
  expect(sent[0]?.body).toBeUndefined();
  expect(written).toMatchObject({
    key: "to/b.txt",
    size: 11,
    userMetadata: { writtenby: "stowage" },
  });
});

test("a missing source is `NotFound` naming it after one attempt", async () => {
  stubFetch(notFound);

  const failure = await failureOf(() => storage().move("from/a.txt", "to/b.txt"));

  expect(failure).toMatchObject({
    code: "NotFound",
    operation: "move",
    key: "from/a.txt",
    attempts: 1,
  });
});

test("`move` is repeated like every other request", async () => {
  vi.spyOn(Math, "random").mockReturnValue(0);

  const answers = [backendError(), moved()];
  const sent = stubFetch(() => answers.shift() ?? moved());

  const written = await storage().move("from/a.txt", "to/b.txt");

  expect(sent.map((request) => request.url)).toEqual([moveUrl, moveUrl]);
  expect(written.key).toBe("to/b.txt");
});

test("a `404` after an attempt that received no response rejects with that `NetworkError`", async () => {
  vi.spyOn(Math, "random").mockReturnValue(0);

  const answers = [transportFailure, notFound];

  stubFetch(() => (answers.shift() ?? notFound)());

  const failure = await failureOf(() => storage().move("from/a.txt", "to/b.txt"));

  expect(failure).toMatchObject({
    code: "NetworkError",
    operation: "move",
    key: "from/a.txt",
    retryable: true,
    attempts: 2,
  });
  expect(failure.cause).toBeInstanceOf(TypeError);
});

test("a `404` after an attempt answered with a `5xx` rejects with that `ProviderError`", async () => {
  vi.spyOn(Math, "random").mockReturnValue(0);

  const answers = [backendError(), notFound()];

  stubFetch(() => answers.shift() ?? notFound());

  const failure = await failureOf(() => storage().move("from/a.txt", "to/b.txt"));

  expect(failure).toMatchObject({
    code: "ProviderError",
    status: 503,
    retryable: true,
    attempts: 2,
  });
});

test("a signal that already fired rejects `move` before any request", async () => {
  const sent = stubFetch(() => moved());

  const failure = await storage()
    .move("from/a.txt", "to/b.txt", { signal: AbortSignal.abort() })
    .catch((reason: unknown) => reason);

  expect(failure).toMatchObject({ name: "AbortError" });
  expect(sent).toEqual([]);
});
