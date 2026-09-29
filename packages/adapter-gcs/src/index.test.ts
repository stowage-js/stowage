import { isStorageError, type PutOptions, type StorageError } from "@stowage/core";
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
