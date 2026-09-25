import { type GetOptions, isStorageError, type PutOptions, type StorageError } from "@stowage/core";
import { afterEach, expect, test, vi } from "vitest";

import {
  type AzureBlobAdapterOptions,
  type AzureBlobCredentials,
  azureBlobStorage,
} from "./index.ts";

afterEach(() => {
  vi.unstubAllGlobals();
});

interface SentRequest {
  readonly url: string;
  readonly method: string;
  readonly headers: Headers;
  readonly body: BodyInit | null | undefined;
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
    };

    sent.push(request);

    return await answer(request);
  });

  return sent;
}

/** What Azure answers `Put Blob` with: the entity tag and the time the blob was written. */
function created(): Response {
  return new Response(null, {
    status: 201,
    headers: { etag: '"0x8DCA1B2C3D4E5F6"', "last-modified": "Sun, 30 Aug 2026 12:36:00 GMT" },
  });
}

function blob(body: string, headers: Record<string, string> = {}): Response {
  return new Response(body, {
    status: 200,
    headers: {
      "content-length": String(new TextEncoder().encode(body).length),
      "content-type": "text/plain",
      "last-modified": "Sun, 30 Aug 2026 12:36:00 GMT",
      etag: '"0x8DCA1B2C3D4E5F6"',
      "x-ms-blob-type": "BlockBlob",
      ...headers,
    },
  });
}

function refused(status: number, code: string): Response {
  return new Response(
    `<?xml version="1.0" encoding="utf-8"?><Error><Code>${code}</Code><Message>The specified blob does not exist.</Message></Error>`,
    {
      status,
      headers: { "x-ms-error-code": code, "x-ms-request-id": "request-1" },
    },
  );
}

const accessToken = "eyJ0eXAiOiJKV1QifQ.e30.";
const accountKey = "c3Rvd2FnZQ==";

function storage(overrides: Partial<AzureBlobAdapterOptions> = {}) {
  return azureBlobStorage({
    account: "stowage",
    container: "conformance",
    credentials: { accessToken },
    ...overrides,
  });
}

async function failureOf(operation: () => Promise<unknown>): Promise<StorageError> {
  const failure = await operation().then(
    () => undefined,
    (reason: unknown) => reason,
  );

  if (isStorageError(failure)) return failure;

  throw new Error(`The operation did not reject with a StorageError: ${String(failure)}`);
}

test("the storage names its provider and its container", () => {
  const constructed = storage();

  expect(constructed.provider).toBe("azure-blob");
  expect(constructed.bucket).toBe("conformance");
});

test("`put` of bytes sends one `Put Blob` under the access token", async () => {
  const sent = stubFetch(() => created());
  const body = new TextEncoder().encode("hello world");

  const written = await storage().put("notes/a.txt", body, { contentType: "text/plain" });

  expect(sent).toHaveLength(1);

  const [request] = sent;

  expect(request?.method).toBe("PUT");
  expect(request?.url).toBe("https://stowage.blob.core.windows.net/conformance/notes/a.txt");
  expect(request?.headers.get("authorization")).toBe(`Bearer ${accessToken}`);
  expect(request?.headers.get("x-ms-version")).toBe("2026-04-06");
  expect(request?.headers.get("x-ms-blob-type")).toBe("BlockBlob");
  expect(request?.headers.get("content-type")).toBe("text/plain");
  expect(request?.body).toEqual(body);
  expect(written).toEqual({
    key: "notes/a.txt",
    size: 11,
    lastModified: new Date("2026-08-30T12:36:00Z"),
    etag: "0x8DCA1B2C3D4E5F6",
    contentType: "text/plain",
    userMetadata: {},
  });
});

test("`put` of a string sends its UTF-8 bytes as `application/octet-stream` by default", async () => {
  const sent = stubFetch(() => created());

  const written = await storage().put("greeting", "Grüße");

  expect(sent[0]?.headers.get("content-type")).toBe("application/octet-stream");
  expect(sent[0]?.body).toEqual(new TextEncoder().encode("Grüße"));
  expect(written.size).toBe(7);
});

test("under an account key a request is signed with Shared Key and dated", async () => {
  const sent = stubFetch(() => created());

  await storage({ credentials: { accountKey } }).put("object", "body");

  expect(sent[0]?.headers.get("authorization")).toMatch(/^SharedKey stowage:[A-Za-z0-9+/]+=*$/u);
  expect(sent[0]?.headers.get("x-ms-date")).not.toBeNull();
  expect(sent[0]?.headers.get("x-ms-version")).toBe("2026-04-06");
});

test("the resolver runs before every request, and may change the form between them", async () => {
  const sent = stubFetch(() => created());
  const answers: AzureBlobCredentials[] = [{ accessToken }, { accountKey }];
  const resolve = vi.fn<() => AzureBlobCredentials>(() => answers.shift() ?? { accessToken });
  const constructed = storage({ credentials: resolve });

  await constructed.put("one", "1");
  await constructed.put("two", "2");

  expect(resolve).toHaveBeenCalledTimes(2);
  expect(resolve).toHaveBeenCalledWith({ forceRefresh: false });
  expect(sent[0]?.headers.get("authorization")).toMatch(/^Bearer /u);
  expect(sent[1]?.headers.get("authorization")).toMatch(/^SharedKey /u);
});

test("a refused credential is `InvalidCredentials` naming the field, before any request", async () => {
  const sent = stubFetch(() => created());

  const failure = await failureOf(() =>
    storage({ credentials: { accountKey: "" } }).put("object", "body"),
  );

  expect(failure.code).toBe("InvalidCredentials");
  expect(failure.message).toContain("accountKey");
  expect(failure.attempts).toBe(0);
  expect(failure.operation).toBe("put");
  expect(failure.bucket).toBe("conformance");
  expect(sent).toHaveLength(0);
});

test("a key is percent-encoded segment by segment behind the endpoint's path", async () => {
  const sent = stubFetch(() => created());
  const emulator = storage({
    account: "devstoreaccount1",
    endpoint: "https://127.0.0.1:10000/devstoreaccount1",
  });

  await emulator.put("dir/a b#c?d%e+f'(g)*!/日本", "body");

  expect(sent[0]?.url).toBe(
    "https://127.0.0.1:10000/devstoreaccount1/conformance/dir/a%20b%23c%3Fd%25e%2Bf%27%28g%29%2A%21/%E6%97%A5%E6%9C%AC",
  );
});

test("an escape in the endpoint's path travels once, not encoded a second time", async () => {
  const sent = stubFetch(() => created());

  await storage({ endpoint: "https://blob.example.com/my%20base" }).put("object", "body");

  expect(sent[0]?.url).toBe("https://blob.example.com/my%20base/conformance/object");
});

test("a request under the access token is dated as well", async () => {
  const sent = stubFetch(() => created());

  await storage().put("object", "body");

  expect(Date.parse(sent[0]?.headers.get("x-ms-date") ?? "")).not.toBeNaN();
});

test("a `..` inside a segment reaches the provider as written, never folded by a `URL`", async () => {
  const sent = stubFetch(() => created());

  await storage().put("a/..b/c", "body");

  expect(sent[0]?.url).toBe("https://stowage.blob.core.windows.net/conformance/a/..b/c");
});

test.each([
  ["a key the core refuses", "a//b"],
  ["more than 254 segments", Array.from({ length: 255 }, () => "s").join("/")],
  ["a segment ending in a dot", "dir./object"],
  ["a key ending in a dot", "object."],
  ["a character from U+0080 to U+009F", "object\u0085name"],
])("`put` refuses %s with `InvalidKey` before any request", async (_label, key) => {
  const sent = stubFetch(() => created());

  const failure = await failureOf(() => storage().put(key, "body"));

  expect(failure.code).toBe("InvalidKey");
  expect(failure.attempts).toBe(0);
  expect(failure.key).toBe(key);
  expect(sent).toHaveLength(0);
});

test("254 segments and a dot inside a segment are written", async () => {
  const sent = stubFetch(() => created());

  await storage().put(Array.from({ length: 254 }, () => "s").join("/"), "body");
  await storage().put("dir.d/object.txt", "body");

  expect(sent).toHaveLength(2);
});

test.each([
  ["a segment ending in a dot", "dir./object"],
  ["a character from U+0080 to U+009F", "object\u0085name"],
  ["a trailing slash", "dir/"],
])("`get` names a key holding %s, which another tool may have written", async (_label, key) => {
  const sent = stubFetch(() => blob("body"));

  await storage().get(key);

  expect(sent).toHaveLength(1);
});

test("`get` reads the description and the body out of one response", async () => {
  const sent = stubFetch(() => blob("hello world"));

  const stored = await storage().get("notes/a.txt");

  expect(sent[0]?.method).toBe("GET");
  expect(sent[0]?.url).toBe("https://stowage.blob.core.windows.net/conformance/notes/a.txt");
  expect(sent[0]?.headers.get("x-ms-version")).toBe("2026-04-06");
  expect(sent[0]?.headers.get("accept-encoding")).toBe("identity");
  expect(stored.stat).toEqual({
    key: "notes/a.txt",
    size: 11,
    lastModified: new Date("2026-08-30T12:36:00Z"),
    etag: "0x8DCA1B2C3D4E5F6",
    contentType: "text/plain",
    userMetadata: {},
  });
  expect(await stored.text()).toBe("hello world");
});

test("a body is read once", async () => {
  stubFetch(() => blob("hello world"));

  const stored = await storage().get("object");

  await stored.bytes();

  expect((await failureOf(() => stored.text())).code).toBe("InvalidRequest");
});

test("a body that breaks after `get` resolved is a `NetworkError`", async () => {
  stubFetch(
    () =>
      new Response(
        new ReadableStream({
          pull(controller) {
            controller.error(new TypeError("terminated"));
          },
        }),
        { status: 200, headers: blob("").headers },
      ),
  );

  const stored = await storage().get("object");

  expect((await failureOf(() => stored.bytes())).code).toBe("NetworkError");
});

test("`get` of a missing blob is `NotFound` carrying what the provider answered", async () => {
  stubFetch(() => refused(404, "BlobNotFound"));

  const failure = await failureOf(() => storage().get("absent"));

  expect(failure.code).toBe("NotFound");
  expect(failure.key).toBe("absent");
  expect(failure.operation).toBe("get");
  expect(failure.status).toBe(404);
  expect(failure.providerCode).toBe("BlobNotFound");
  expect(failure.requestId).toBe("request-1");
  expect(failure.retryable).toBe(false);
  expect(failure.attempts).toBe(1);
});

test("a request that received no response is a `NetworkError`", async () => {
  stubFetch(() => {
    throw new TypeError("fetch failed");
  });

  const failure = await failureOf(() => storage().get("object"));

  expect(failure.code).toBe("NetworkError");
  expect(failure.retryable).toBe(true);
  expect(failure.cause).toBeInstanceOf(TypeError);
});

test("a signal that already fired rejects with `AbortError` before any request", async () => {
  const sent = stubFetch(() => blob("body"));

  await expect(storage().get("object", { signal: AbortSignal.abort() })).rejects.toMatchObject({
    name: "AbortError",
  });
  await expect(
    storage().put("object", "body", { signal: AbortSignal.abort() }),
  ).rejects.toMatchObject({ name: "AbortError" });
  expect(sent).toHaveLength(0);
});

test("the storage declares no capability yet", () => {
  expect(storage().capabilities).toEqual([]);
});

test("user metadata is `Unsupported` naming `userMetadata`, and an empty set is written", async () => {
  const sent = stubFetch(() => created());

  const failure = await failureOf(() =>
    storage().put("object", "body", { userMetadata: { WrittenBy: "stowage" } }),
  );

  expect(failure.code).toBe("Unsupported");
  expect(failure.capability).toBe("userMetadata");
  expect(failure.attempts).toBe(0);

  await storage().put("object", "body", { userMetadata: {} });

  expect(sent).toHaveLength(1);
});

test("a range is `Unsupported` naming `rangeReads`", async () => {
  const sent = stubFetch(() => blob("body"));

  const failure = await failureOf(() => storage().get("object", { range: { start: 8, end: 4 } }));

  expect(failure.code).toBe("Unsupported");
  expect(failure.capability).toBe("rangeReads");
  expect(sent).toHaveLength(0);
});

// The options are as unknown to the types as they are to the storage, which is what the
// case is about: the type catches one at the call site, and this the rest.
// oxlint-disable-next-line no-unsafe-type-assertion -- the point of the case
const unknownPutOption = { storageClass: "Cool" } as PutOptions;
// oxlint-disable-next-line no-unsafe-type-assertion -- the point of the case
const unknownGetOption = { versionId: "1" } as GetOptions;

test.each([
  ["put", () => storage().put("object", "body", unknownPutOption)],
  ["get", () => storage().get("object", unknownGetOption)],
])("`%s` refuses an unknown option by name", async (_operation, call) => {
  stubFetch(() => created());

  const failure = await failureOf(call);

  expect(failure.code).toBe("InvalidOption");
  expect(failure.attempts).toBe(0);
});

test("an empty `contentType` is `InvalidOption`", async () => {
  stubFetch(() => created());

  expect((await failureOf(() => storage().put("o", "b", { contentType: "" }))).code).toBe(
    "InvalidOption",
  );
});
