import { isStorageError, type StorageError } from "@stowage/core";
import { afterEach, expect, test, vi } from "vitest";

import { sha256Hex } from "./hash.ts";
import { type S3AdapterOptions, s3Storage } from "./index.ts";

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

function storedResponse(body: string, headers: Record<string, string> = {}): Response {
  return new Response(body, {
    status: 200,
    headers: {
      "content-length": String(new TextEncoder().encode(body).length),
      "content-type": "text/plain",
      "last-modified": "Sun, 30 Aug 2015 12:36:00 GMT",
      etag: '"6805f2cfc46c0f04559748bb39"',
      ...headers,
    },
  });
}

/** What a provider answers `PutObject` with: an entity tag and the time it accepted it. */
function accepted(): Response {
  return new Response(null, {
    status: 200,
    headers: { etag: '"written"', date: "Sun, 30 Aug 2015 12:36:00 GMT" },
  });
}

const credentials = { accessKeyId: "AKIDEXAMPLE", secretAccessKey: "secret" };

function options(overrides: Partial<S3AdapterOptions> = {}): S3AdapterOptions {
  return { bucket: "stowage", region: "eu-central-1", credentials, ...overrides };
}

async function rejection(act: () => Promise<unknown>): Promise<StorageError> {
  try {
    await act();
  } catch (failure) {
    if (isStorageError(failure)) return failure;

    throw failure;
  }

  throw new Error("The call resolved");
}

test("it names the provider, the bucket and what it declares", () => {
  const storage = s3Storage(options());

  expect(storage.provider).toBe("s3");
  expect(storage.bucket).toBe("stowage");
  expect(storage.capabilities).toEqual([]);
});

test("`put` addresses the bucket virtual-hosted over https", async () => {
  const sent = stubFetch(accepted);

  await s3Storage(options()).put("folder/object.txt", "body");

  expect(sent[0]?.url).toBe("https://stowage.s3.eu-central-1.amazonaws.com/folder/object.txt");
  expect(sent[0]?.method).toBe("PUT");
});

test("`forcePathStyle` carries the bucket in the first segment of the path", async () => {
  const sent = stubFetch(accepted);

  await s3Storage(options({ endpoint: "http://127.0.0.1:8333", forcePathStyle: true })).put(
    "object.txt",
    "body",
  );

  expect(sent[0]?.url).toBe("http://127.0.0.1:8333/stowage/object.txt");
});

// Spec 7.4: `#`, `%`, `?`, `+`, a space and everything above ASCII reach the provider as
// written, which a `URL` would decode, re-encode or fold away.
test("a key is percent-encoded segment by segment on the path", async () => {
  const sent = stubFetch(accepted);

  await s3Storage(options()).put("a b/c#d/e%f/g+h/ሴ/..x", "body");

  expect(sent[0]?.url).toBe(
    "https://stowage.s3.eu-central-1.amazonaws.com/a%20b/c%23d/e%25f/g%2Bh/%E1%88%B4/..x",
  );
});

test("every request carries the hash over the body it sends", async () => {
  const sent = stubFetch(accepted);

  await s3Storage(options()).put("object.txt", "body");

  expect(sent[0]?.headers.get("x-amz-content-sha256")).toBe(await sha256Hex("body"));
});

test("a request that carries no body hashes the empty one", async () => {
  const sent = stubFetch(() => storedResponse("stored"));

  await s3Storage(options()).stat("object.txt");

  expect(sent[0]?.headers.get("x-amz-content-sha256")).toBe(await sha256Hex(""));
});

test("every request is signed", async () => {
  const sent = stubFetch(accepted);

  await s3Storage(options()).put("object.txt", "body");

  expect(sent[0]?.headers.get("authorization")).toMatch(
    /^AWS4-HMAC-SHA256 Credential=AKIDEXAMPLE\/\d{8}\/eu-central-1\/s3\/aws4_request, SignedHeaders=\S+, Signature=[\da-f]{64}$/u,
  );
  expect(sent[0]?.headers.get("x-amz-date")).toMatch(/^\d{8}T\d{6}Z$/u);
});

test("the resolver runs before every signed request and nothing is held between them", async () => {
  stubFetch(accepted);

  const resolve = vi.fn<() => typeof credentials>(() => credentials);
  const storage = s3Storage(options({ credentials: resolve }));

  await storage.put("one.txt", "body");
  await storage.put("other.txt", "body");

  expect(resolve).toHaveBeenCalledTimes(2);
  expect(resolve).toHaveBeenCalledWith({ forceRefresh: false });
});

test("a credential the resolver refuses is told against the storage that asked", async () => {
  stubFetch(accepted);

  const failure = await rejection(
    async () =>
      await s3Storage(options({ credentials: { accessKeyId: "", secretAccessKey: "s" } })).put(
        "object.txt",
        "body",
      ),
  );

  expect(failure.code).toBe("InvalidCredentials");
  expect(failure.message).toContain("accessKeyId");
  expect(failure.operation).toBe("put");
  expect(failure.bucket).toBe("stowage");
  expect(failure.attempts).toBe(0);
});

test("`put` describes what it wrote", async () => {
  stubFetch(accepted);

  const written = await s3Storage(options()).put("object.txt", "hallo", {
    contentType: "text/plain",
  });

  expect(written).toMatchObject({
    key: "object.txt",
    size: 5,
    contentType: "text/plain",
    etag: "written",
    lastModified: new Date("2015-08-30T12:36:00Z"),
    userMetadata: {},
  });
});

// Spec 4.4 has the time come from the provider, which spec 4.6 keeps a description from
// being handed back with a part invented for it.
test("an answer without the time it accepted the object is a `ProviderError`", async () => {
  stubFetch(() => new Response(null, { status: 200, headers: { etag: '"written"' } }));

  const failure = await rejection(async () => await s3Storage(options()).put("object.txt", "body"));

  expect(failure.code).toBe("ProviderError");
  expect(failure.operation).toBe("put");
});

test("`put` stores `application/octet-stream` where no content type was given", async () => {
  const sent = stubFetch(accepted);

  await s3Storage(options()).put("object.txt", new Uint8Array([1, 2, 3]));

  expect(sent[0]?.headers.get("content-type")).toBe("application/octet-stream");
});

test("`get` answers the description and the body of one response", async () => {
  stubFetch(() => storedResponse("a stored body"));

  const stored = await s3Storage(options()).get("object.txt");

  expect(stored.stat).toMatchObject({
    key: "object.txt",
    size: 13,
    contentType: "text/plain",
    etag: "6805f2cfc46c0f04559748bb39",
  });
  expect(await stored.text()).toBe("a stored body");
});

test("a second read of a body is refused", async () => {
  stubFetch(() => storedResponse("a stored body"));

  const stored = await s3Storage(options()).get("object.txt");

  await stored.bytes();

  expect((await rejection(async () => await stored.text())).code).toBe("InvalidRequest");
});

test("a missing key is `NotFound` after the one attempt it cost", async () => {
  stubFetch(() => new Response("", { status: 404, headers: { "x-amz-request-id": "abc" } }));

  const failure = await rejection(async () => await s3Storage(options()).get("absent.txt"));

  expect(failure.code).toBe("NotFound");
  expect(failure.operation).toBe("get");
  expect(failure.key).toBe("absent.txt");
  expect(failure.status).toBe(404);
  expect(failure.requestId).toBe("abc");
  expect(failure.retryable).toBe(false);
  expect(failure.attempts).toBe(1);
});

test("`exists` answers `false` for a missing key and rethrows every other failure", async () => {
  stubFetch(() => new Response("", { status: 404 }));

  expect(await s3Storage(options()).exists("absent.txt")).toBe(false);

  stubFetch(() => new Response("", { status: 403 }));

  expect((await rejection(async () => await s3Storage(options()).exists("denied.txt"))).code).toBe(
    "AccessDenied",
  );
});

test("a request that received no response is a transient `NetworkError`", async () => {
  stubFetch(() => {
    throw new TypeError("fetch failed");
  });

  const failure = await rejection(async () => await s3Storage(options()).get("object.txt"));

  expect(failure.code).toBe("NetworkError");
  expect(failure.retryable).toBe(true);
  expect(failure.attempts).toBe(1);
  expect(failure.cause).toBeInstanceOf(TypeError);
});

test.each([
  ["put", async (): Promise<unknown> => await s3Storage(options()).put("ends-in-a-slash/", "body")],
  ["get", async (): Promise<unknown> => await s3Storage(options()).get("/leading-slash")],
])("`%s` refuses an invalid key before any request", async (_operation, act) => {
  const sent = stubFetch(accepted);
  const failure = await rejection(act);

  expect(failure.code).toBe("InvalidKey");
  expect(sent).toHaveLength(0);
});

test("a signal that already fired rejects before any request", async () => {
  const sent = stubFetch(accepted);

  await expect(
    s3Storage(options()).put("object.txt", "body", { signal: AbortSignal.abort() }),
  ).rejects.toThrow(expect.objectContaining({ name: "AbortError" }));
  expect(sent).toHaveLength(0);
});

test.each([
  [
    "userMetadata",
    async (): Promise<unknown> =>
      await s3Storage(options()).put("object.txt", "body", { userMetadata: { note: "x" } }),
  ],
  [
    "rangeReads",
    async (): Promise<unknown> =>
      await s3Storage(options()).get("object.txt", { range: { start: 0, end: 1 } }),
  ],
])("a call needing the undeclared `%s` is `Unsupported`", async (capability, act) => {
  const sent = stubFetch(accepted);
  const failure = await rejection(act);

  expect(failure.code).toBe("Unsupported");
  expect(failure.capability).toBe(capability);
  expect(sent).toHaveLength(0);
});

test("an unknown option is refused by name before any request", async () => {
  const sent = stubFetch(accepted);
  const failure = await rejection(
    async () =>
      // oxlint-disable-next-line no-unsafe-type-assertion -- the point of the case
      await s3Storage(options()).put("object.txt", "body", { storageClass: "GLACIER" } as object),
  );

  expect(failure.code).toBe("InvalidOption");
  expect(failure.message).toContain("storageClass");
  expect(sent).toHaveLength(0);
});

test("the session token travels as a signed header", async () => {
  const sent = stubFetch(accepted);

  await s3Storage(options({ credentials: { ...credentials, sessionToken: "the-token" } })).put(
    "object.txt",
    "body",
  );

  expect(sent[0]?.headers.get("x-amz-security-token")).toBe("the-token");
  expect(sent[0]?.headers.get("authorization")).toContain("x-amz-security-token");
});
