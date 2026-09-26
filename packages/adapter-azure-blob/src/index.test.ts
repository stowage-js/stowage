import { type GetOptions, isStorageError, type PutOptions, type StorageError } from "@stowage/core";
import { afterEach, expect, test, vi } from "vitest";

import {
  type AzureBlobAdapterOptions,
  type AzureBlobCredentials,
  azureBlobStorage,
} from "./index.ts";

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
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

/** What Azure answers a failed request with: the code in a header, and a document beside it. */
function refused(
  status: number,
  code: string,
  message = "The specified blob does not exist.",
  headers: Record<string, string> = {},
): Response {
  return new Response(
    `\uFEFF<?xml version="1.0" encoding="utf-8"?><Error><Code>${code}</Code><Message>${message}</Message></Error>`,
    {
      status,
      headers: {
        "content-type": "application/xml",
        "x-ms-error-code": code,
        "x-ms-request-id": "request-1",
        ...headers,
      },
    },
  );
}

/** The delay of every wait, with the timer itself fired at once so the run goes on. */
function recordedDelays(): number[] {
  const delays: number[] = [];
  const fire = globalThis.setTimeout;

  vi.stubGlobal("setTimeout", (handler: () => void, milliseconds?: number): unknown => {
    delays.push(milliseconds ?? 0);

    return fire(handler, 0);
  });

  return delays;
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
  const sent = stubFetch(() => refused(404, "BlobNotFound"));

  const failure = await failureOf(() => storage().get("absent"));

  expect(failure.code).toBe("NotFound");
  expect(failure.key).toBe("absent");
  expect(failure.operation).toBe("get");
  expect(failure.status).toBe(404);
  expect(failure.providerCode).toBe("BlobNotFound");
  expect(sent).toHaveLength(1);
  expect(failure.requestId).toBe("request-1");
  expect(failure.retryable).toBe(false);
  expect(failure.attempts).toBe(1);
});

test("a request that keeps receiving no response is a `NetworkError` after three attempts", async () => {
  vi.spyOn(Math, "random").mockReturnValue(0);
  const sent = stubFetch(() => {
    throw new TypeError("fetch failed");
  });

  const failure = await failureOf(() => storage().get("object"));

  expect(failure.code).toBe("NetworkError");
  expect(failure.retryable).toBe(true);
  expect(failure.attempts).toBe(3);
  expect(failure.cause).toBeInstanceOf(TypeError);
  expect(sent).toHaveLength(3);
});

test.each([408, 429, 500, 503])(
  "a transient %s resolves and authorizes the next attempt again",
  async (status) => {
    vi.spyOn(Math, "random").mockReturnValue(0);
    const resolve = vi
      .fn<() => AzureBlobCredentials>()
      .mockReturnValueOnce({ accessToken })
      .mockReturnValue({ accountKey });
    const sent = stubFetch(() => (sent.length === 1 ? refused(status, "ServerBusy") : created()));

    const written = await storage({ credentials: resolve }).put("object", "body");

    expect(written.key).toBe("object");
    expect(sent).toHaveLength(2);
    expect(resolve).toHaveBeenCalledTimes(2);
    expect(resolve).toHaveBeenNthCalledWith(2, { forceRefresh: false });
    expect(sent[0]?.headers.get("authorization")).toBe(`Bearer ${accessToken}`);
    expect(sent[1]?.headers.get("authorization")).toMatch(/^SharedKey /u);
    expect(sent[1]?.body).toEqual(sent[0]?.body);
  },
);

test.each([false, { maxAttempts: 2 }] as const)(
  "a transient failure respects retry %j",
  async (retry) => {
    vi.spyOn(Math, "random").mockReturnValue(0);
    const sent = stubFetch(() => refused(503, "ServerBusy"));

    const failure = await failureOf(() => storage({ retry }).get("object"));
    const attempts = retry === false ? 1 : retry.maxAttempts;

    expect(sent).toHaveLength(attempts);
    expect(failure).toMatchObject({
      attempts,
      status: 503,
      providerCode: "ServerBusy",
      requestId: "request-1",
      retryable: true,
    });
  },
);

test("an abort after a transient response prevents the next attempt", async () => {
  const controller = new AbortController();
  const aborted = new DOMException("Aborted", "AbortError");
  const sent = stubFetch(() => {
    controller.abort(aborted);

    return refused(503, "ServerBusy");
  });

  await expect(storage().get("object", { signal: controller.signal })).rejects.toBe(aborted);
  expect(sent).toHaveLength(1);
});

test("an AbortError from fetch travels on without retrying", async () => {
  const aborted = new DOMException("Aborted", "AbortError");
  const sent = stubFetch(() => {
    throw aborted;
  });

  await expect(storage().get("object")).rejects.toBe(aborted);
  expect(sent).toHaveLength(1);
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

test("the provider's code decides the error, and its message travels word for word", async () => {
  stubFetch(() =>
    refused(
      403,
      "AuthenticationFailed",
      "Server failed to authenticate the request.\nRequestId:request-1\nTime:2026-09-26T08:00:00.0000000Z",
    ),
  );

  const failure = await failureOf(() => storage().get("object"));

  expect(failure.code).toBe("InvalidCredentials");
  expect(failure.providerCode).toBe("AuthenticationFailed");
  expect(failure.message).toBe(
    "Server failed to authenticate the request.\nRequestId:request-1\nTime:2026-09-26T08:00:00.0000000Z",
  );
  expect(failure.status).toBe(403);
  expect(failure.requestId).toBe("request-1");
  expect(failure.retryable).toBe(false);
});

test.each([
  [404, "BlobNotFound", "NotFound"],
  [404, "ContainerNotFound", "NotFound"],
  [404, "ResourceNotFound", "NotFound"],
  [403, "AuthorizationPermissionMismatch", "AccessDenied"],
  [403, "InsufficientAccountPermissions", "AccessDenied"],
  [403, "AccountIsDisabled", "AccessDenied"],
  [409, "UnauthorizedBlobOverwrite", "AccessDenied"],
  [401, "NoAuthenticationInformation", "InvalidCredentials"],
  [403, "AuthenticationFailed", "InvalidCredentials"],
  [416, "InvalidRange", "InvalidRequest"],
  [413, "RequestBodyTooLarge", "InvalidRequest"],
  [409, "BlockCountExceedsLimit", "InvalidRequest"],
  [400, "MetadataTooLarge", "InvalidRequest"],
  [400, "InvalidMetadata", "InvalidRequest"],
  [400, "InvalidBlockList", "ProviderError"],
  [400, "InvalidBlobOrBlock", "ProviderError"],
  [409, "PendingCopyOperation", "ProviderError"],
  [409, "BlobArchived", "ProviderError"],
  [409, "SnapshotsPresent", "ProviderError"],
  [412, "LeaseIdMissing", "ProviderError"],
  [409, "BlobImmutableDueToPolicy", "ProviderError"],
])("a %i carrying `%s` is `%s`", async (status, providerCode, code) => {
  stubFetch(() => refused(status, providerCode, "Refused."));

  const failure = await failureOf(() => storage().get("object"));

  expect(failure.code).toBe(code);
  expect(failure.providerCode).toBe(providerCode);
  expect(failure.retryable).toBe(false);
});

test("a provider code the table does not hold falls to the status", async () => {
  stubFetch(() => refused(403, "SomethingNewEntirely", "No."));

  const failure = await failureOf(() => storage().get("object"));

  expect(failure.code).toBe("AccessDenied");
  expect(failure.providerCode).toBe("SomethingNewEntirely");
});

test("a failure whose body is no error document is told by its status", async () => {
  stubFetch(
    () =>
      new Response("<html>Bad Gateway</html>", {
        status: 409,
        headers: { "x-ms-request-id": "request-1" },
      }),
  );

  const failure = await failureOf(() => storage().get("object"));

  expect(failure.code).toBe("ProviderError");
  expect(failure.providerCode).toBeUndefined();
  expect(failure.message).toContain("409");
  expect(failure.requestId).toBe("request-1");
});

test("an AbortError while reading a failed response travels on", async () => {
  const aborted = new DOMException("Aborted", "AbortError");
  const sent = stubFetch(
    () =>
      new Response(
        new ReadableStream({
          start(controller) {
            controller.error(aborted);
          },
        }),
        { status: 409 },
      ),
  );

  await expect(storage().get("object")).rejects.toBe(aborted);
  expect(sent).toHaveLength(1);
});

test("a non-abort body read failure leaves the provider message unset", async () => {
  stubFetch(
    () =>
      new Response(
        new ReadableStream({
          start(controller) {
            controller.error(new TypeError("broken body"));
          },
        }),
        { status: 409 },
      ),
  );

  const failure = await failureOf(() => storage().get("object"));

  expect(failure.code).toBe("ProviderError");
  expect(failure.message).toContain("409");
});

test("`retry: false` sends one attempt", async () => {
  const sent = stubFetch(() => {
    throw new TypeError("fetch failed");
  });

  const failure = await failureOf(() => storage({ retry: false }).get("object"));

  expect(failure.attempts).toBe(1);
  expect(sent).toHaveLength(1);
});

test("`maxAttempts` bounds the attempts", async () => {
  vi.spyOn(Math, "random").mockReturnValue(0);
  const sent = stubFetch(() => refused(503, "ServerBusy", "The server is busy."));

  const failure = await failureOf(() => storage({ retry: { maxAttempts: 2 } }).get("object"));

  expect(failure.code).toBe("ProviderError");
  expect(failure.providerCode).toBe("ServerBusy");
  expect(failure.message).toBe("The server is busy.");
  expect(failure.retryable).toBe(true);
  expect(failure.attempts).toBe(2);
  expect(sent).toHaveLength(2);
});

// Spec 8.5: the group is a transport failure that received no response plus `408`, `429`
// and every `5xx`. No provider code adds to it and none removes from it (ADR 0013).
test.each([408, 429, 500, 502, 503, 504])("a %i is repeated on the budget", async (status) => {
  vi.spyOn(Math, "random").mockReturnValue(0);
  const sent = stubFetch(() => refused(status, "NothingThisTableHolds", "Try again."));

  const failure = await failureOf(() => storage().get("object"));

  expect(failure.retryable).toBe(true);
  expect(failure.attempts).toBe(3);
  expect(sent).toHaveLength(3);
});

test.each([400, 403, 404, 409, 412])("a %i is not repeated", async (status) => {
  const sent = stubFetch(() => refused(status, "NothingThisTableHolds", "No."));

  const failure = await failureOf(() => storage().get("object"));

  expect(failure.retryable).toBe(false);
  expect(failure.attempts).toBe(1);
  expect(sent).toHaveLength(1);
});

test("a repeat resolves the credential again and sends the held body again", async () => {
  vi.spyOn(Math, "random").mockReturnValue(0);
  const responses = [refused(500, "OperationTimedOut", "Operation could not be completed.")];
  const sent = stubFetch(() => responses.shift() ?? created());
  const resolve = vi.fn<() => AzureBlobCredentials>(() => ({ accessToken }));
  const body = new TextEncoder().encode("held");

  await storage({ credentials: resolve }).put("object", body);

  expect(resolve).toHaveBeenCalledTimes(2);
  expect(resolve).toHaveBeenCalledWith({ forceRefresh: false });
  expect(sent).toHaveLength(2);
  expect(sent[1]?.body).toEqual(body);
});

// Spec 8.5 reads no `Retry-After`, which Azure's Blob service does not promise to send.
test("the wait is the backoff curve and never a `Retry-After`", async () => {
  vi.spyOn(Math, "random").mockReturnValue(1);
  const delays = recordedDelays();

  stubFetch(() => refused(503, "ServerBusy", "The server is busy.", { "retry-after": "120" }));

  await failureOf(() => storage().get("object"));

  expect(delays).toEqual([200, 400]);
});

test("an abort interrupts the wait before another attempt", async () => {
  vi.spyOn(Math, "random").mockReturnValue(0.5);
  const controller = new AbortController();
  const sent = stubFetch(() => {
    setTimeout(() => controller.abort(), 0);

    return refused(503, "ServerBusy", "The server is busy.");
  });

  await expect(storage().get("object", { signal: controller.signal })).rejects.toMatchObject({
    name: "AbortError",
  });
  expect(sent).toHaveLength(1);
});

/** What Azure answers a token that expired, and one it does not accept at all. */
function tokenRefused(): Response {
  return refused(
    401,
    "InvalidAuthenticationInfo",
    "Server failed to authenticate the request. Please refer to the information in the www-authenticate header.",
  );
}

test("a refused access token costs one repeat under `forceRefresh` and no wait", async () => {
  const delays = recordedDelays();
  const responses = [tokenRefused()];
  const sent = stubFetch(() => responses.shift() ?? blob("body"));
  const tokens = ["stale", "fresh"];
  const resolve = vi.fn<() => AzureBlobCredentials>(() => ({
    accessToken: tokens.shift() ?? "fresh",
  }));

  await storage({ credentials: resolve }).get("object");

  expect(sent).toHaveLength(2);
  expect(resolve).toHaveBeenNthCalledWith(1, { forceRefresh: false });
  expect(resolve).toHaveBeenNthCalledWith(2, { forceRefresh: true });
  expect(sent[1]?.headers.get("authorization")).toBe("Bearer fresh");
  expect(delays).toEqual([]);
});

// ADR 0021: the repeat is how a caching resolver is told to refresh rather than a repeat
// of the transport, and without it an expired token has no way back.
test("`retry: false` does not switch the repeat off, and a second refusal is `InvalidCredentials`", async () => {
  const sent = stubFetch(() => tokenRefused());

  const failure = await failureOf(() => storage({ retry: false }).get("object"));

  expect(failure.code).toBe("InvalidCredentials");
  expect(failure.attempts).toBe(2);
  expect(failure.retryable).toBe(false);
  expect(failure.status).toBe(401);
  expect(failure.providerCode).toBe("InvalidAuthenticationInfo");
  expect(failure.message).toMatch(/access token expired or is not accepted/u);
  expect(sent).toHaveLength(2);
});

test("under an account key the same refusal is not repeated", async () => {
  const sent = stubFetch(() => tokenRefused());
  const resolve = vi.fn<() => AzureBlobCredentials>(() => ({ accountKey }));

  const failure = await failureOf(() => storage({ credentials: resolve }).get("object"));

  expect(failure.code).toBe("InvalidCredentials");
  expect(failure.attempts).toBe(1);
  expect(resolve).toHaveBeenCalledTimes(1);
  expect(sent).toHaveLength(1);
});

test("one request costs at most six: three attempts, each doubled by the repeat", async () => {
  vi.spyOn(Math, "random").mockReturnValue(0);
  let answered = 0;
  const sent = stubFetch(() => {
    answered += 1;

    return answered % 2 === 1 ? tokenRefused() : refused(503, "ServerBusy", "The server is busy.");
  });

  const failure = await failureOf(() => storage().get("object"));

  expect(failure.code).toBe("ProviderError");
  expect(failure.attempts).toBe(6);
  expect(sent).toHaveLength(6);
});

test("an account that takes no account key is `InvalidCredentials` naming the access token", async () => {
  const sent = stubFetch(() =>
    refused(
      403,
      "KeyBasedAuthenticationNotPermitted",
      "Key based authentication is not permitted on this storage account.",
    ),
  );

  const failure = await failureOf(() => storage({ credentials: { accountKey } }).get("object"));

  expect(failure.code).toBe("InvalidCredentials");
  expect(failure.message).toContain("accessToken");
  expect(failure.retryable).toBe(false);
  expect(failure.attempts).toBe(1);
  expect(sent).toHaveLength(1);
});

/** What Azure answers `Get Blob Properties` with: the description, and no body. */
function described(headers: Record<string, string> = {}): Response {
  return new Response(null, {
    status: 200,
    headers: {
      "content-length": "11",
      "content-type": "text/plain",
      "last-modified": "Sun, 30 Aug 2026 12:36:00 GMT",
      etag: '"0x8DCA1B2C3D4E5F6"',
      "x-ms-blob-type": "BlockBlob",
      ...headers,
    },
  });
}

/** What Azure answers a `HEAD` that failed with: the code in a header, and no body. */
function headRefused(status: number, code?: string): Response {
  return new Response(null, {
    status,
    headers: {
      "x-ms-request-id": "request-1",
      ...(code === undefined ? {} : { "x-ms-error-code": code }),
    },
  });
}

test("`stat` sends one `HEAD` and describes the blob from its headers", async () => {
  const sent = stubFetch(() => described());

  const stat = await storage().stat("notes/a.txt");

  expect(sent).toHaveLength(1);
  expect(sent[0]?.method).toBe("HEAD");
  expect(sent[0]?.url).toBe("https://stowage.blob.core.windows.net/conformance/notes/a.txt");
  expect(sent[0]?.headers.get("accept-encoding")).toBe("identity");
  expect(stat).toEqual({
    key: "notes/a.txt",
    size: 11,
    lastModified: new Date("2026-08-30T12:36:00Z"),
    etag: "0x8DCA1B2C3D4E5F6",
    contentType: "text/plain",
    userMetadata: {},
  });
});

test.each(["BlobNotFound", "ContainerNotFound"])(
  "`stat` reads `%s` off the header of a `HEAD`",
  async (providerCode) => {
    stubFetch(() => headRefused(404, providerCode));

    const failure = await failureOf(() => storage().stat("absent"));

    expect(failure).toMatchObject({
      code: "NotFound",
      operation: "stat",
      key: "absent",
      status: 404,
      providerCode,
      requestId: "request-1",
      attempts: 1,
    });
    expect(failure.message).toContain(providerCode);
  },
);

test("`exists` answers `true` for a blob and `false` for `NotFound` alone", async () => {
  stubFetch(() => described());

  expect(await storage().exists("object")).toBe(true);

  const sent = stubFetch(() => headRefused(404, "ContainerNotFound"));

  expect(await storage().exists("object")).toBe(false);
  expect(sent[0]?.method).toBe("HEAD");
});

test("`exists` rethrows every failure other than `NotFound`", async () => {
  stubFetch(() => headRefused(403, "AuthorizationPermissionMismatch"));

  const failure = await failureOf(() => storage().exists("object"));

  expect(failure.code).toBe("AccessDenied");
  expect(failure.operation).toBe("exists");
});

test.each([
  ["stat", () => storage().stat("a//b")],
  ["exists", () => storage().exists("a//b")],
])("`%s` refuses a key the core refuses before any request", async (_operation, call) => {
  const sent = stubFetch(() => described());

  const failure = await failureOf(call);

  expect(failure.code).toBe("InvalidKey");
  expect(failure.attempts).toBe(0);
  expect(sent).toHaveLength(0);
});

test("`stat` names a key holding a segment ending in a dot, which another tool may have written", async () => {
  const sent = stubFetch(() => described());

  await storage().stat("dir./object");

  expect(sent).toHaveLength(1);
});

// oxlint-disable-next-line no-unsafe-type-assertion -- the point of the case
const unknownOperationOption = { versionId: "1" } as { signal?: AbortSignal };

test.each([
  ["stat", () => storage().stat("object", unknownOperationOption)],
  ["exists", () => storage().exists("object", unknownOperationOption)],
])("`%s` refuses an unknown option by name", async (_operation, call) => {
  stubFetch(() => described());

  const failure = await failureOf(call);

  expect(failure.code).toBe("InvalidOption");
  expect(failure.message).toContain("versionId");
});

test("`stat` and `exists` reject a signal that already fired before any request", async () => {
  const sent = stubFetch(() => described());

  await expect(storage().stat("object", { signal: AbortSignal.abort() })).rejects.toMatchObject({
    name: "AbortError",
  });
  await expect(storage().exists("object", { signal: AbortSignal.abort() })).rejects.toMatchObject({
    name: "AbortError",
  });
  expect(sent).toHaveLength(0);
});

const tooLongKey = "k".repeat(1025);
const tooManySegments = Array.from({ length: 255 }, () => "s").join("/");

test.each([
  ["`stat` of a key above 1,024 characters", () => storage().stat(tooLongKey)],
  ["`exists` of a key above 1,024 characters", () => storage().exists(tooLongKey)],
  ["`stat` of a key above 254 segments", () => storage().stat(tooManySegments)],
  ["`get` of a key above 1,024 characters", () => storage().get(tooLongKey)],
])("%s answered `400` is `InvalidKey`", async (_label, call) => {
  stubFetch(() => headRefused(400, "InvalidUri"));

  const failure = await failureOf(call);

  expect(failure).toMatchObject({ code: "InvalidKey", status: 400, attempts: 1 });
});

test("a `400` for a key within the limits stays `ProviderError`", async () => {
  stubFetch(() => headRefused(400, "InvalidUri"));

  const failure = await failureOf(() => storage().stat("k".repeat(1024)));

  expect(failure.code).toBe("ProviderError");
});

test("a `400` whose code the table holds is told by the table, whatever the key", async () => {
  stubFetch(() => refused(400, "InvalidMetadata", "The metadata is invalid."));

  const failure = await failureOf(() => storage().get(tooLongKey));

  expect(failure.code).toBe("InvalidRequest");
});

// Spec 4.6: the listing sends nothing until it is read, so the refusal is the reader's.
test.each([
  ["a `pageSize` of 0", { pageSize: 0 }, "pageSize"],
  ["a `pageSize` above 1000", { pageSize: 1001 }, "pageSize"],
  ["an empty `delimiter`", { delimiter: "" }, "delimiter"],
  ["a `cursor` no storage handed out", { cursor: "this-is-no-cursor" }, "cursor"],
  ["a `cursor` of `adapter-s3`", { cursor: btoa("stowage-s3-1:0061") }, "cursor"],
])("`list` refuses %s before any request", async (_label, options, option) => {
  const sent = stubFetch(() => described());
  const listing = storage().list(options);

  const failure = await failureOf(() => listing.page());

  expect(failure.code).toBe("InvalidOption");
  expect(failure.message).toContain(option);
  expect(failure.operation).toBe("list");
  expect(failure.attempts).toBe(0);
  expect(sent).toHaveLength(0);
});

test("`list` refuses a prefix the core refuses, from the iteration as well", async () => {
  const listing = storage().list({ prefix: "a//" });

  const failure = await failureOf(() => listing[Symbol.asyncIterator]().next());

  expect(failure.code).toBe("InvalidKey");
});

test.each(["copy", "move"] as const)(
  "`%s` of a key onto itself is `InvalidRequest` before any request",
  async (operation) => {
    const sent = stubFetch(() => created());

    const failure = await failureOf(() => storage()[operation]("object", "object"));

    expect(failure.code).toBe("InvalidRequest");
    expect(failure.operation).toBe(operation);
    expect(failure.attempts).toBe(0);
    expect(sent).toHaveLength(0);
  },
);

test("`copy` refuses a destination Azure does not take before any request", async () => {
  const failure = await failureOf(() => storage().copy("object", "dir./object"));

  expect(failure.code).toBe("InvalidKey");
  expect(failure.key).toBe("dir./object");
});

interface ListedName {
  readonly name: string;
  readonly encoded?: boolean;
}

interface ListedBlob extends ListedName {
  readonly size?: string;
  readonly lastModified?: string;
  readonly etag?: string;
}

function nameElement({ name, encoded }: ListedName): string {
  return encoded === true ? `<Name Encoded="true">${name}</Name>` : `<Name>${name}</Name>`;
}

/** What Azure answers `List Blobs` with: blobs and pseudo-directories, and the next marker. */
function enumeration(
  blobs: readonly ListedBlob[],
  {
    prefixes = [],
    nextMarker = "",
  }: { prefixes?: readonly (string | ListedName)[]; nextMarker?: string } = {},
): Response {
  const blobElements = blobs.map(
    (listed) =>
      `<Blob>${nameElement(listed)}<Properties>` +
      (listed.lastModified === undefined
        ? ""
        : `<Last-Modified>${listed.lastModified}</Last-Modified>`) +
      (listed.etag === undefined ? "" : `<Etag>${listed.etag}</Etag>`) +
      (listed.size === undefined ? "" : `<Content-Length>${listed.size}</Content-Length>`) +
      `<Content-Type>text/plain</Content-Type><BlobType>BlockBlob</BlobType></Properties></Blob>`,
  );
  const prefixElements = prefixes.map(
    (prefix) =>
      `<BlobPrefix>${nameElement(typeof prefix === "string" ? { name: prefix } : prefix)}</BlobPrefix>`,
  );

  return new Response(
    `﻿<?xml version="1.0" encoding="utf-8"?><EnumerationResults ServiceEndpoint="https://stowage.blob.core.windows.net/" ContainerName="conformance"><Blobs>${blobElements.join("")}${prefixElements.join("")}</Blobs><NextMarker>${nextMarker}</NextMarker></EnumerationResults>`,
    { status: 200, headers: { "content-type": "application/xml", "x-ms-request-id": "request-1" } },
  );
}

async function iteratedKeys(listing: AsyncIterable<{ readonly key: string }>): Promise<string[]> {
  const keys: string[] = [];

  for await (const entry of listing) keys.push(entry.key);

  return keys;
}

function listedBlob(name: string, size = "11"): ListedBlob {
  return { name, size, lastModified: "Sun, 30 Aug 2026 12:36:00 GMT", etag: "0x8DCA1B2C3D4E5F6" };
}

test("`page()` sends one `List Blobs` below the prefix and describes each object", async () => {
  const sent = stubFetch(() =>
    enumeration([listedBlob("notes/a.txt"), listedBlob("notes/b.txt", "0")]),
  );

  const page = await storage().list({ prefix: "notes/", pageSize: 2 }).page();

  expect(sent).toHaveLength(1);

  const url = new URL(sent[0]?.url ?? "");

  expect(sent[0]?.method).toBe("GET");
  expect(url.pathname).toBe("/conformance");
  expect(url.searchParams.get("restype")).toBe("container");
  expect(url.searchParams.get("comp")).toBe("list");
  expect(url.searchParams.get("prefix")).toBe("notes/");
  expect(url.searchParams.get("maxresults")).toBe("2");
  expect(url.searchParams.has("delimiter")).toBe(false);
  expect(url.searchParams.has("marker")).toBe(false);
  expect(page).toEqual({
    objects: [
      {
        key: "notes/a.txt",
        size: 11,
        lastModified: new Date("2026-08-30T12:36:00Z"),
        etag: "0x8DCA1B2C3D4E5F6",
      },
      {
        key: "notes/b.txt",
        size: 0,
        lastModified: new Date("2026-08-30T12:36:00Z"),
        etag: "0x8DCA1B2C3D4E5F6",
      },
    ],
    prefixes: [],
    cursor: undefined,
  });
});

test("a cursor continues the listing from a `list` of its own, and the last page carries none", async () => {
  const nextMarker =
    "2!80!MDAwMDE2IW5vdGVzL2IudHh0ITAwMDAyOCE5OTk5LTEyLTMxVDIzOjU5OjU5Ljk5OTk5OTlaIQ--";
  const sent = stubFetch((request) =>
    new URL(request.url).searchParams.has("marker")
      ? enumeration([listedBlob("notes/b.txt")])
      : enumeration([listedBlob("notes/a.txt")], { nextMarker }),
  );

  const first = await storage().list({ prefix: "notes/", pageSize: 1 }).page();

  expect(first.cursor).toEqual(expect.any(String));
  expect(first.cursor).not.toContain(nextMarker);

  const rest = await storage().list({ prefix: "notes/", pageSize: 1, cursor: first.cursor }).page();

  expect(new URL(sent[1]?.url ?? "").searchParams.get("marker")).toBe(nextMarker);
  expect(rest.objects.map((entry) => entry.key)).toEqual(["notes/b.txt"]);
  expect(rest.cursor).toBeUndefined();
});

test("the iteration walks every page, each continuing from the marker before it", async () => {
  const sent = stubFetch((request) => {
    const marker = new URL(request.url).searchParams.get("marker");

    if (marker === null) return enumeration([listedBlob("a")], { nextMarker: "after-a" });
    if (marker === "after-a") return enumeration([listedBlob("b")], { nextMarker: "after-b" });

    return enumeration([listedBlob("c")]);
  });

  expect(await iteratedKeys(storage().list({ pageSize: 1 }))).toEqual(["a", "b", "c"]);
  expect(sent.map((request) => new URL(request.url).searchParams.get("marker"))).toEqual([
    null,
    "after-a",
    "after-b",
  ]);
});

test("with a delimiter the pseudo-directories reach `prefixes`, and the iteration yields the objects alone", async () => {
  const sent = stubFetch(() =>
    enumeration([listedBlob("notes/a.txt")], { prefixes: ["notes/one/", "notes/two/"] }),
  );
  const options = { prefix: "notes/", delimiter: "/" };

  const page = await storage().list(options).page();
  const iterated = await iteratedKeys(storage().list(options));

  expect(new URL(sent[0]?.url ?? "").searchParams.get("delimiter")).toBe("/");
  expect(page.objects.map((entry) => entry.key)).toEqual(["notes/a.txt"]);
  expect(page.prefixes).toEqual(["notes/one/", "notes/two/"]);
  expect(iterated).toEqual(["notes/a.txt"]);
});

test("a name marked `Encoded` is decoded as percent-encoded UTF-8, a pseudo-directory's too", async () => {
  stubFetch(() =>
    enumeration([{ ...listedBlob("notes/%EF%BF%BE%2B%20.txt"), encoded: true }], {
      prefixes: [{ name: "notes/%EF%BF%BF/", encoded: true }, "notes/%41/"],
    }),
  );

  const page = await storage().list({ prefix: "notes/", delimiter: "/" }).page();

  expect(page.objects.map((entry) => entry.key)).toEqual(["notes/\uFFFE+ .txt"]);
  expect(page.prefixes).toEqual(["notes/\uFFFF/", "notes/%41/"]);
});

function listingAnswer(document: string): Response {
  return new Response(document, {
    status: 200,
    headers: { "content-type": "application/xml", "x-ms-request-id": "request-1" },
  });
}

const properties =
  "<Properties><Last-Modified>Sun, 30 Aug 2026 12:36:00 GMT</Last-Modified><Content-Length>11</Content-Length></Properties>";

function listingOf(blobs: string): Response {
  return listingAnswer(
    `<EnumerationResults><Blobs>${blobs}</Blobs><NextMarker/></EnumerationResults>`,
  );
}

// Spec 4.6: an entry without one of its three parts is reported, never filled in.
test.each([
  ["an entry without a key", () => listingOf(`<Blob>${properties}</Blob>`), "no key"],
  ["an entry with an empty key", () => listingOf(`<Blob><Name/>${properties}</Blob>`), "no key"],
  [
    "an entry without a size",
    () => enumeration([{ ...listedBlob("a"), size: undefined }]),
    "no size",
  ],
  ["an entry with a size that is no number", () => enumeration([listedBlob("a", "-1")]), "no size"],
  [
    "an entry without a last-modified time",
    () => enumeration([{ ...listedBlob("a"), lastModified: undefined }]),
    "no last-modified time",
  ],
  [
    "a pseudo-directory without a name",
    () => listingOf("<BlobPrefix></BlobPrefix>"),
    "a pseudo-directory with no name",
  ],
  [
    "an encoded name that does not decode",
    () => enumeration([{ ...listedBlob("a%E0"), encoded: true }]),
    "does not decode",
  ],
  ["a document the parser refuses", () => listingAnswer("<EnumerationResults>"), "outside the XML"],
  ["another root", () => listingAnswer("<Error><Code>x</Code></Error>"), "<Error>"],
])("%s is `ProviderError`", async (_label, answer, said) => {
  stubFetch(answer);

  const failure = await failureOf(() => storage().list({ prefix: "notes/" }).page());

  expect(failure.code).toBe("ProviderError");
  expect(failure.message).toContain(said);
  expect(failure.operation).toBe("list");
  expect(failure.attempts).toBe(1);
  expect(failure.status).toBe(200);
  expect(failure.requestId).toBe("request-1");
  expect(failure.retryable).toBe(false);
});

test("a listing whose body breaks while it is read is a `NetworkError`", async () => {
  stubFetch(
    () =>
      new Response(
        new ReadableStream({
          start(controller) {
            controller.enqueue(new TextEncoder().encode("<EnumerationResults>"));
            controller.error(new TypeError("terminated"));
          },
        }),
        { status: 200, headers: { "x-ms-request-id": "request-1" } },
      ),
  );

  const failure = await failureOf(() => storage().list().page());

  expect(failure.code).toBe("NetworkError");
  expect(failure.operation).toBe("list");
  expect(failure.retryable).toBe(true);
  expect(failure.requestId).toBe("request-1");
});

test("a provider that hands back the marker it was sent is `ProviderError`, not a loop", async () => {
  // A listing that went on would end after three pages rather than hang the run.
  const sent = stubFetch((request) =>
    enumeration([listedBlob("a")], {
      nextMarker:
        sent.length > 3 ? "" : (new URL(request.url).searchParams.get("marker") ?? "after-a"),
    }),
  );

  const failure = await failureOf(async () => await iteratedKeys(storage().list()));

  expect(failure.code).toBe("ProviderError");
  expect(failure.message).toContain("marker");
  expect(failure.status).toBe(200);
  expect(failure.requestId).toBe("request-1");
  expect(sent).toHaveLength(2);
});

test("`list` sends nothing until the listing is read", async () => {
  const sent = stubFetch(() => enumeration([]));

  const listing = storage().list({ prefix: "notes/" });

  expect(sent).toHaveLength(0);

  await listing.page();

  expect(sent).toHaveLength(1);
});
