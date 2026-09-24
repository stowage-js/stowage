import { isStorageError, type StorageError, type StoredObject } from "@stowage/core";
import { afterEach, expect, test, vi } from "vitest";

import { sha256Hex } from "./hash.ts";
import { md5Base64 } from "./md5.ts";
import { type S3AdapterOptions, s3Storage } from "./index.ts";

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

/** The error document a provider answers every failed request but a `HEAD` with. */
function refused(
  status: number,
  code: string,
  message: string,
  headers: Record<string, string> = {},
): Response {
  return new Response(
    `<?xml version="1.0" encoding="UTF-8"?>\n<Error><Code>${code}</Code><Message>${message}</Message><Resource>/stowage/object.txt</Resource><RequestId>abc</RequestId></Error>`,
    {
      status,
      headers: { "content-type": "application/xml", "x-amz-request-id": "abc", ...headers },
    },
  );
}

/** A `ListObjectsV2` answer holding `entries`, as AWS writes one. */
function listed(
  entries: readonly string[],
  page: { prefixes?: readonly string[]; nextToken?: string } = {},
): Response {
  const contents = entries
    .map(
      (key) =>
        `<Contents><Key>${key}</Key><LastModified>2026-09-23T08:00:00.000Z</LastModified><ETag>&quot;etag&quot;</ETag><Size>4</Size><StorageClass>STANDARD</StorageClass></Contents>`,
    )
    .join("");
  const prefixes = (page.prefixes ?? [])
    .map((prefix) => `<CommonPrefixes><Prefix>${prefix}</Prefix></CommonPrefixes>`)
    .join("");
  const next =
    page.nextToken === undefined
      ? "<IsTruncated>false</IsTruncated>"
      : `<IsTruncated>true</IsTruncated><NextContinuationToken>${page.nextToken}</NextContinuationToken>`;

  return new Response(
    `<?xml version="1.0" encoding="UTF-8"?>\n<ListBucketResult xmlns="http://s3.amazonaws.com/doc/2006-03-01/"><Name>stowage</Name><MaxKeys>1000</MaxKeys>${next}${contents}${prefixes}</ListBucketResult>`,
    { status: 200, headers: { "content-type": "application/xml" } },
  );
}

/** A `200` whose body breaks with `failure` once it is read. */
function brokenBody(failure: unknown): Response {
  return new Response(
    new ReadableStream({
      pull(controller) {
        controller.error(failure);
      },
    }),
    { status: 200, headers: { "x-amz-request-id": "broken-request" } },
  );
}

/** The query parameters a request carried, by name. */
function queryOf(request: SentRequest | undefined): Record<string, string> {
  return Object.fromEntries(new URL(request?.url ?? "https://absent.invalid/").searchParams);
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
  expect(storage.capabilities).toEqual(["presignedUrls", "rangeReads", "userMetadata"]);
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

// Node's `fetch` offers `gzip, deflate, br` of its own, and R2 compresses a JSON or text
// body on that offer and drops its `Content-Length`, so `size` would have nothing to read.
test("every request asks for the body as the provider stores it", async () => {
  const sent = stubFetch(() => storedResponse("stored"));

  await s3Storage(options()).get("object.txt");

  expect(sent[0]?.headers.get("accept-encoding")).toBe("identity");
});

test("the encoding asked for stays out of the signature", async () => {
  const sent = stubFetch(() => storedResponse("stored"));

  await s3Storage(options()).stat("object.txt");

  expect(sent[0]?.headers.get("authorization")).not.toContain("accept-encoding");
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

test.each([
  ["missing", undefined],
  ["empty", ""],
  ["whitespace-only", " \t "],
])("a %s content length is an incomplete provider description", async (_case, length) => {
  stubFetch(
    () =>
      new Response(null, {
        status: 200,
        headers: {
          "last-modified": "Sun, 30 Aug 2015 12:36:00 GMT",
          ...(length === undefined ? {} : { "content-length": length }),
        },
      }),
  );

  const failure = await rejection(async () => await s3Storage(options()).stat("object.txt"));

  expect(failure.code).toBe("ProviderError");
  expect(failure.message).toContain("no length");
});

test("a second read of a body is refused", async () => {
  stubFetch(() => storedResponse("a stored body"));

  const stored = await s3Storage(options()).get("object.txt");

  await stored.bytes();

  expect((await rejection(async () => await stored.text())).code).toBe("InvalidRequest");
});

/** A `200` whose body breaks with `failure` after its first chunk. */
function bodyBreakingPartway(failure: unknown): Response {
  let pulls = 0;

  return new Response(
    new ReadableStream<Uint8Array>({
      pull(controller) {
        pulls += 1;

        if (pulls === 1) controller.enqueue(new TextEncoder().encode('{"partial":'));
        else controller.error(failure);
      },
    }),
    {
      status: 200,
      headers: {
        "content-length": "1024",
        "last-modified": "Sun, 30 Aug 2015 12:36:00 GMT",
        "x-amz-request-id": "broken-request",
      },
    },
  );
}

const readers = {
  stream: async (stored: StoredObject) => {
    const reader = stored.stream().getReader();

    for (;;) if ((await reader.read()).done) return;
  },
  bytes: async (stored: StoredObject) => await stored.bytes(),
  text: async (stored: StoredObject) => await stored.text(),
  json: async (stored: StoredObject) => await stored.json(),
};

test.each(Object.entries(readers))(
  "a body that breaks partway through `get` arrives as a `StorageError` through `%s()`",
  async (_reader, read) => {
    const cause = new TypeError("terminated");

    stubFetch(() => bodyBreakingPartway(cause));

    const stored = await s3Storage(options()).get("object.json");
    const failure = await rejection(async () => await read(stored));

    expect(failure).toMatchObject({
      code: "NetworkError",
      operation: "get",
      key: "object.json",
      bucket: "stowage",
      retryable: true,
      attempts: 1,
      requestId: "broken-request",
      cause,
    });
  },
);

test("a missing key is `NotFound` after the one attempt it cost", async () => {
  const sent = stubFetch(
    () => new Response("", { status: 404, headers: { "x-amz-request-id": "abc" } }),
  );

  const failure = await rejection(async () => await s3Storage(options()).get("absent.txt"));

  expect(failure.code).toBe("NotFound");
  expect(failure.operation).toBe("get");
  expect(failure.key).toBe("absent.txt");
  expect(failure.status).toBe(404);
  expect(failure.requestId).toBe("abc");
  expect(failure.retryable).toBe(false);
  expect(failure.attempts).toBe(1);
  expect(sent).toHaveLength(1);
});

test("`exists` answers `false` for a missing key and rethrows every other failure", async () => {
  stubFetch(() => new Response("", { status: 404 }));

  expect(await s3Storage(options()).exists("absent.txt")).toBe(false);

  stubFetch(() => new Response("", { status: 403 }));

  expect((await rejection(async () => await s3Storage(options()).exists("denied.txt"))).code).toBe(
    "AccessDenied",
  );
});

test("a request that repeatedly receives no response preserves the final attempt count", async () => {
  vi.spyOn(Math, "random").mockReturnValue(0);
  const sent = stubFetch(() => {
    throw new TypeError("fetch failed");
  });

  const failure = await rejection(async () => await s3Storage(options()).get("object.txt"));

  expect(failure.code).toBe("NetworkError");
  expect(failure.retryable).toBe(true);
  expect(failure.attempts).toBe(3);
  expect(failure.cause).toBeInstanceOf(TypeError);
  expect(sent).toHaveLength(3);
});

test("`retry: false` limits a transport failure to one attempt", async () => {
  const sent = stubFetch(() => {
    throw new TypeError("fetch failed");
  });

  const failure = await rejection(
    async () => await s3Storage(options({ retry: false })).get("object.txt"),
  );

  expect(failure.code).toBe("NetworkError");
  expect(failure.attempts).toBe(1);
  expect(sent).toHaveLength(1);
});

test("transient responses are re-signed and retried", async () => {
  vi.spyOn(Math, "random").mockReturnValue(0);
  const responses = [refused(503, "SlowDown", "Please reduce your request rate")];
  const sent = stubFetch(() => responses.shift() ?? storedResponse("stored"));
  const held = [
    { ...credentials, accessKeyId: "FIRST" },
    { ...credentials, accessKeyId: "SECOND" },
  ];
  const resolve = vi.fn<() => typeof credentials>(() => held.shift() ?? credentials);

  await s3Storage(options({ credentials: resolve })).get("object.txt");

  expect(resolve).toHaveBeenCalledTimes(2);
  expect(sent).toHaveLength(2);
  expect(sent[0]?.headers.get("authorization")).toContain("Credential=FIRST/");
  expect(sent[1]?.headers.get("authorization")).toContain("Credential=SECOND/");
});

test("a final transient response preserves its attempt count", async () => {
  vi.spyOn(Math, "random").mockReturnValue(0);
  const sent = stubFetch(() => refused(503, "SlowDown", "Please reduce your request rate"));

  const failure = await rejection(
    async () => await s3Storage(options({ retry: { maxAttempts: 2 } })).get("object.txt"),
  );

  expect(failure.code).toBe("ProviderError");
  expect(failure.status).toBe(503);
  expect(failure.providerCode).toBe("SlowDown");
  expect(failure.message).toBe("Please reduce your request rate");
  expect(failure.retryable).toBe(true);
  expect(failure.attempts).toBe(2);
  expect(sent).toHaveLength(2);
});

// Spec 7.5: neither promised provider sends `Retry-After` on its S3 API, and the adapter
// honors no header it could not test against the endpoint of ADR 0012.
test("the wait is the backoff curve and never a `Retry-After`", async () => {
  vi.spyOn(Math, "random").mockReturnValue(1);
  const delays = recordedDelays();

  stubFetch(() => refused(503, "SlowDown", "Slow down", { "retry-after": "120" }));

  await rejection(async () => await s3Storage(options()).get("object.txt"));

  expect(delays).toEqual([200, 400]);
});

test.each([
  [0, [0, 0]],
  [0.25, [50, 100]],
  [0.999, [199.8, 399.6]],
])("a random draw of %d waits a share of the curve", async (draw, expected) => {
  vi.spyOn(Math, "random").mockReturnValue(draw);
  const delays = recordedDelays();

  stubFetch(() => refused(500, "InternalError", "We encountered an internal error."));

  await rejection(async () => await s3Storage(options()).get("object.txt"));

  expect(delays).toEqual(expected.map((delay) => expect.closeTo(delay)));
});

test("an abort interrupts the wait before another attempt", async () => {
  vi.spyOn(Math, "random").mockReturnValue(0.5);
  const controller = new AbortController();
  const sent = stubFetch(() => {
    setTimeout(() => controller.abort(), 0);

    return refused(503, "SlowDown", "Please reduce your request rate");
  });

  await expect(
    s3Storage(options()).get("object.txt", { signal: controller.signal }),
  ).rejects.toThrow(expect.objectContaining({ name: "AbortError" }));
  expect(sent).toHaveLength(1);
});

test("the provider's code decides the error and its message travels word for word", async () => {
  stubFetch(() => refused(404, "NoSuchKey", "The specified key does not exist."));

  const failure = await rejection(async () => await s3Storage(options()).get("absent.txt"));

  expect(failure.code).toBe("NotFound");
  expect(failure.providerCode).toBe("NoSuchKey");
  expect(failure.message).toBe("The specified key does not exist.");
  expect(failure.status).toBe(404);
  expect(failure.requestId).toBe("abc");
  expect(failure.retryable).toBe(false);
});

test("a provider code the table does not hold falls to the status", async () => {
  stubFetch(() => refused(403, "SomethingNewEntirely", "No."));

  const failure = await rejection(async () => await s3Storage(options()).get("object.txt"));

  expect(failure.code).toBe("AccessDenied");
  expect(failure.providerCode).toBe("SomethingNewEntirely");
});

// Spec 7.9: `HEAD` carries no body, so `stat` and `exists` report the status alone.
test("`stat` reports the status of a `HEAD` without a provider code", async () => {
  stubFetch(() => refused(403, "AccessDenied", "Access Denied"));

  const failure = await rejection(async () => await s3Storage(options()).stat("object.txt"));

  expect(failure.code).toBe("AccessDenied");
  expect(failure.providerCode).toBeUndefined();
  expect(failure.message).toContain("403");
});

// ADR 0013: a second request signed against the same wrong clock fails the same way.
test("`RequestTimeTooSkewed` is `InvalidRequest` and is not repeated", async () => {
  const sent = stubFetch(() =>
    refused(
      403,
      "RequestTimeTooSkewed",
      "The difference between the request time and the current time is too large",
    ),
  );

  const failure = await rejection(async () => await s3Storage(options()).get("object.txt"));

  expect(failure.code).toBe("InvalidRequest");
  expect(failure.retryable).toBe(false);
  expect(failure.attempts).toBe(1);
  expect(sent).toHaveLength(1);
});

// Spec 7.1: nothing discovers a region, so the answer names the option that is wrong.
test("a `301` names `region` and the region the provider answered", async () => {
  stubFetch(() =>
    refused(301, "PermanentRedirect", "The bucket is in this region", {
      "x-amz-bucket-region": "eu-west-1",
    }),
  );

  const failure = await rejection(async () => await s3Storage(options()).get("object.txt"));

  expect(failure.code).toBe("InvalidOption");
  expect(failure.message).toContain("`region`");
  expect(failure.message).toContain("eu-west-1");
});

test("an `Expired` answer costs one repeat under `forceRefresh` and no wait", async () => {
  const delays = recordedDelays();
  const responses = [refused(403, "ExpiredToken", "The provided token has expired.")];
  const sent = stubFetch(() => responses.shift() ?? storedResponse("stored"));
  const resolve = vi.fn<() => typeof credentials>(() => credentials);

  await s3Storage(options({ credentials: resolve })).get("object.txt");

  expect(sent).toHaveLength(2);
  expect(resolve).toHaveBeenNthCalledWith(1, { forceRefresh: false });
  expect(resolve).toHaveBeenNthCalledWith(2, { forceRefresh: true });
  expect(delays).toEqual([]);
});

// ADR 0013: the repeat is how a caching resolver is told to refresh rather than a repeat
// of the transport, and without it an expired credential has no way back.
test("`retry: false` does not switch the `Expired` repeat off", async () => {
  const sent = stubFetch(() => refused(403, "ExpiredToken", "The provided token has expired."));

  const failure = await rejection(
    async () => await s3Storage(options({ retry: false })).get("object.txt"),
  );

  expect(failure.code).toBe("Expired");
  expect(failure.attempts).toBe(2);
  expect(sent).toHaveLength(2);
});

test("one request costs at most six: three attempts, each doubled by the repeat", async () => {
  vi.spyOn(Math, "random").mockReturnValue(0);
  let answered = 0;
  const sent = stubFetch(() => {
    answered += 1;

    return answered % 2 === 1
      ? refused(403, "ExpiredToken", "The provided token has expired.")
      : refused(503, "SlowDown", "Please reduce your request rate");
  });

  const failure = await rejection(async () => await s3Storage(options()).get("object.txt"));

  expect(failure.code).toBe("ProviderError");
  expect(failure.attempts).toBe(6);
  expect(sent).toHaveLength(6);
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

test("`put` writes the user metadata as `x-amz-meta-*` headers and reports it folded", async () => {
  const sent = stubFetch(accepted);

  const written = await s3Storage(options()).put("object.txt", "body", {
    userMetadata: { "Written-By": "stowage", greeting: "grüße" },
  });

  expect(sent[0]?.headers.get("x-amz-meta-written-by")).toBe("stowage");
  expect(sent[0]?.headers.get("x-amz-meta-greeting")).toBe("=?UTF-8?B?Z3LDvMOfZQ==?=");
  expect(sent[0]?.headers.get("authorization")).toContain("x-amz-meta-greeting");
  expect(written.userMetadata).toEqual({ "written-by": "stowage", greeting: "grüße" });
});

test("a user metadata set over 2 KB is `InvalidRequest` before any request", async () => {
  const sent = stubFetch(accepted);
  const failure = await rejection(
    async () =>
      await s3Storage(options()).put("object.txt", "body", {
        userMetadata: { note: "x".repeat(2048) },
      }),
  );

  expect(failure.code).toBe("InvalidRequest");
  expect(failure.attempts).toBe(0);
  expect(sent).toHaveLength(0);
});

test.each([
  [
    "stat",
    async (): Promise<unknown> => (await s3Storage(options()).stat("object.txt")).userMetadata,
  ],
  [
    "get",
    async (): Promise<unknown> => (await s3Storage(options()).get("object.txt")).stat.userMetadata,
  ],
])("`%s` reads the user metadata back out of the headers", async (_operation, act) => {
  stubFetch(() =>
    storedResponse("body", {
      "x-amz-meta-written-by": "stowage",
      "x-amz-meta-greeting": "=?UTF-8?B?Z3LDvMOfZQ==?=",
    }),
  );

  expect(await act()).toEqual({ "written-by": "stowage", greeting: "grüße" });
});

test("a ranged `get` asks for the bytes and reports the size of the whole object", async () => {
  const sent = stubFetch(
    () =>
      new Response("0123", {
        status: 206,
        headers: {
          "content-length": "4",
          "content-range": "bytes 100-103/1024",
          "last-modified": "Sun, 30 Aug 2015 12:36:00 GMT",
        },
      }),
  );

  const stored = await s3Storage(options()).get("object.txt", { range: { start: 100, end: 103 } });

  expect(sent[0]?.headers.get("range")).toBe("bytes=100-103");
  expect(sent[0]?.headers.get("authorization")).toContain("range");
  expect(stored.stat.size).toBe(1024);
  expect(await stored.text()).toBe("0123");
});

test("a range without an end asks for the rest of the object", async () => {
  const sent = stubFetch(
    () =>
      new Response("3", {
        status: 206,
        headers: {
          "content-length": "1",
          "content-range": "bytes 1023-1023/1024",
          "last-modified": "Sun, 30 Aug 2015 12:36:00 GMT",
        },
      }),
  );

  await s3Storage(options()).get("object.txt", { range: { start: 1023 } });

  expect(sent[0]?.headers.get("range")).toBe("bytes=1023-");
});

test.each([
  ["a negative start", { start: -1 }],
  ["a fractional start", { start: 0.5 }],
  ["an end below the start", { start: 8, end: 4 }],
  ["a fractional end", { start: 0, end: 1.5 }],
])("%s is `InvalidOption` naming `range` before any request", async (_case, range) => {
  const sent = stubFetch(accepted);
  const failure = await rejection(
    async () => await s3Storage(options()).get("object.txt", { range }),
  );

  expect(failure.code).toBe("InvalidOption");
  expect(failure.message).toContain("range");
  expect(sent).toHaveLength(0);
});

test("a range starting at the size of the object is `InvalidRequest`", async () => {
  stubFetch(() => refused(416, "InvalidRange", "The requested range is not satisfiable"));

  const failure = await rejection(
    async () => await s3Storage(options()).get("object.txt", { range: { start: 1024 } }),
  );

  expect(failure.code).toBe("InvalidRequest");
  expect(failure.status).toBe(416);
});

// A provider may answer the whole of an empty object to a range rather than a `416`.
test("a range the provider answers with the whole empty object is `InvalidRequest`", async () => {
  stubFetch(() => storedResponse(""));

  const failure = await rejection(
    async () => await s3Storage(options()).get("object.txt", { range: { start: 0 } }),
  );

  expect(failure.code).toBe("InvalidRequest");
  expect(failure.attempts).toBe(1);
});

test("a range the provider answers with the whole of a longer object is a `ProviderError`", async () => {
  stubFetch(() => storedResponse("a stored body"));

  const failure = await rejection(
    async () => await s3Storage(options()).get("object.txt", { range: { start: 1 } }),
  );

  expect(failure.code).toBe("ProviderError");
});

test.each([
  ["no end", { start: 0 }],
  ["an end beyond the object", { start: 0, end: 100 }],
])(
  "a range covering the whole object, answered with all of it, is what was asked for: %s",
  async (_case, range) => {
    stubFetch(() => storedResponse("a stored body"));

    const stored = await s3Storage(options()).get("object.txt", { range });

    expect(stored.stat.size).toBe(13);
    expect(await stored.text()).toBe("a stored body");
  },
);

test.each([["bytes 0-3"], ["bytes 0-3/*"], ["items 0-3/4"], [undefined]])(
  "a partial answer with the content range %j is a `ProviderError`",
  async (contentRange) => {
    stubFetch(
      () =>
        new Response("0123", {
          status: 206,
          headers: {
            "content-length": "4",
            "last-modified": "Sun, 30 Aug 2015 12:36:00 GMT",
            ...(contentRange === undefined ? {} : { "content-range": contentRange }),
          },
        }),
    );

    const failure = await rejection(
      async () => await s3Storage(options()).get("object.txt", { range: { start: 0, end: 3 } }),
    );

    expect(failure.code).toBe("ProviderError");
  },
);

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

// Spec 4.6: the listing sends nothing until it is read, so the refusal is the reader's.
test("`list` refuses a `pageSize` outside its range before any request", async () => {
  const sent = stubFetch(accepted);
  const failure = await rejection(
    async () => await s3Storage(options()).list({ pageSize: 0 }).page(),
  );

  expect(failure.code).toBe("InvalidOption");
  expect(failure.message).toContain("pageSize");
  expect(failure.operation).toBe("list");
  expect(sent).toHaveLength(0);
});

test("`copy` of a key onto itself is `InvalidRequest` before any request", async () => {
  const sent = stubFetch(accepted);
  const failure = await rejection(
    async () => await s3Storage(options()).copy("object.txt", "object.txt"),
  );

  expect(failure.code).toBe("InvalidRequest");
  expect(failure.operation).toBe("copy");
  expect(failure.attempts).toBe(0);
  expect(sent).toHaveLength(0);
});

// Spec 7.5: the group is a transport failure that received no response plus `408`, `429`
// and every `5xx`. No provider code adds to it and none removes from it (ADR 0013).
test.each([408, 429, 500, 502, 503])("a %i is repeated on the budget", async (status) => {
  vi.spyOn(Math, "random").mockReturnValue(0);
  const sent = stubFetch(() => refused(status, "NothingThisTableHolds", "Try again"));

  const failure = await rejection(async () => await s3Storage(options()).get("object.txt"));

  expect(failure.retryable).toBe(true);
  expect(failure.attempts).toBe(3);
  expect(sent).toHaveLength(3);
});

test.each([400, 403, 404, 409])("a %i is not repeated", async (status) => {
  const sent = stubFetch(() => refused(status, "NothingThisTableHolds", "No."));

  const failure = await rejection(async () => await s3Storage(options()).get("object.txt"));

  expect(failure.retryable).toBe(false);
  expect(failure.attempts).toBe(1);
  expect(sent).toHaveLength(1);
});

test.each([
  [500, "AccessDenied"],
  [503, "NoSuchKey"],
])("a %i is repeated on the budget though it carries `%s`", async (status, code) => {
  vi.spyOn(Math, "random").mockReturnValue(0);
  const sent = stubFetch(() => refused(status, code, "Try again"));

  const failure = await rejection(async () => await s3Storage(options()).get("object.txt"));

  expect(failure.providerCode).toBe(code);
  expect(failure.attempts).toBe(3);
  expect(sent).toHaveLength(3);
});

// AWS answers `RequestTimeout` with `400` where a client sent its body too slowly.
test.each(["RequestTimeout", "SlowDown"])("a 400 carrying `%s` is not repeated", async (code) => {
  const sent = stubFetch(() => refused(400, code, "No."));

  const failure = await rejection(async () => await s3Storage(options()).get("object.txt"));

  expect(failure.providerCode).toBe(code);
  expect(failure.attempts).toBe(1);
  expect(sent).toHaveLength(1);
});

test("`page()` sends one `ListObjectsV2` for the prefix, the delimiter and the page size", async () => {
  const sent = stubFetch(() => listed(["photos/cat.jpg"], { prefixes: ["photos/2026/"] }));

  const page = await s3Storage(options())
    .list({ prefix: "photos/", delimiter: "/", pageSize: 5 })
    .page();

  expect(sent).toHaveLength(1);
  expect(sent[0]?.method).toBe("GET");
  expect(new URL(sent[0]?.url ?? "").pathname).toBe("/");
  expect(queryOf(sent[0])).toEqual({
    "list-type": "2",
    prefix: "photos/",
    delimiter: "/",
    "max-keys": "5",
  });
  expect(page).toEqual({
    objects: [
      {
        key: "photos/cat.jpg",
        size: 4,
        lastModified: new Date("2026-09-23T08:00:00.000Z"),
        etag: "etag",
      },
    ],
    prefixes: ["photos/2026/"],
    cursor: undefined,
  });
});

// Spec 4.6: iterated, the listing walks the pages itself and yields the objects of each,
// the pseudo-directories a delimiter shapes a page with reaching the caller through
// `page()` alone.
test("the iteration walks every page and yields the objects alone", async () => {
  const sent = stubFetch((request) =>
    queryOf(request)["continuation-token"] === undefined
      ? listed(["a/1", "a/2"], { prefixes: ["a/b/"], nextToken: "token+1/=" })
      : listed(["a/3"]),
  );
  const keys: string[] = [];

  for await (const entry of s3Storage(options()).list({ prefix: "a/", delimiter: "/" })) {
    keys.push(entry.key);
  }

  expect(keys).toEqual(["a/1", "a/2", "a/3"]);
  expect(sent).toHaveLength(2);
  expect(queryOf(sent[1])).toEqual({
    "list-type": "2",
    prefix: "a/",
    delimiter: "/",
    "max-keys": "1000",
    "continuation-token": "token+1/=",
  });
});

// Spec 4.6: a cursor is opaque and continues the listing from a `list` call of its own,
// which is what a caller paging from another process holds.
test("a page's cursor continues the listing from a new `list`", async () => {
  const sent = stubFetch((request) =>
    queryOf(request)["continuation-token"] === undefined
      ? listed(["a"], { nextToken: "1ueGcxLPRx1Tr/XYExHnhbYLgveDs2J/wm36Hy4vbOwM=" })
      : listed(["b"]),
  );
  const storage = s3Storage(options());

  const first = await storage.list({ pageSize: 1 }).page();

  expect(first.cursor).toEqual(expect.any(String));
  expect(first.cursor).not.toContain("1ueGcxLPRx1Tr");

  const second = await storage.list({ pageSize: 1, cursor: first.cursor }).page();

  expect(queryOf(sent[1])["continuation-token"]).toBe(
    "1ueGcxLPRx1Tr/XYExHnhbYLgveDs2J/wm36Hy4vbOwM=",
  );
  expect(second.objects.map((entry) => entry.key)).toEqual(["b"]);
  expect(second.cursor).toBeUndefined();
});

// Spec 4.3: a cursor the storage did not produce is `InvalidOption` naming `cursor`,
// whether stowage tells it apart itself or the provider refuses the position inside.
test.each(["not-a-cursor", btoa("stowage-memory-1:0061"), ""])(
  "the cursor %j is refused by name before any request",
  async (cursor) => {
    const sent = stubFetch(() => listed([]));
    const failure = await rejection(async () => await s3Storage(options()).list({ cursor }).page());

    expect(failure.code).toBe("InvalidOption");
    expect(failure.message).toContain("cursor");
    expect(failure.attempts).toBe(0);
    expect(sent).toHaveLength(0);
  },
);

test("a position the provider refuses is `InvalidOption` naming `cursor`", async () => {
  const sent = stubFetch((request) =>
    queryOf(request)["continuation-token"] === undefined
      ? listed(["a"], { nextToken: "genuine" })
      : // The position is stowage's own, and the provider no longer continues from it.
        refused(400, "InvalidArgument", "The continuation token provided is incorrect"),
  );
  const storage = s3Storage(options());
  const { cursor } = await storage.list().page();

  const failure = await rejection(async () => await storage.list({ cursor }).page());

  expect(failure.code).toBe("InvalidOption");
  expect(failure.message).toContain("cursor");
  expect(failure.status).toBe(400);
  expect(sent).toHaveLength(2);
});

test("an `InvalidArgument` on the first listing page is an `InvalidRequest`", async () => {
  const sent = stubFetch(() => refused(400, "InvalidArgument", "The prefix is invalid"));

  const failure = await rejection(async () => await s3Storage(options()).list().page());

  expect(failure.code).toBe("InvalidRequest");
  expect(failure.message).toBe("The prefix is invalid");
  expect(sent).toHaveLength(1);
});

// Spec 7.4: the prefix travels percent-encoded like a key on the path, and a key comes
// back out of its entities as it was written.
test("keys holding `#`, `%`, `?`, `+`, a space and characters above ASCII round-trip", async () => {
  const keys = [
    "a#b",
    "100%",
    "q?x=1",
    "a+b",
    "hello world.txt",
    "it's",
    "a&b<c>",
    "Grüße/日本語/ключ.txt",
  ];
  const escaped = keys.map((key) =>
    key.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;"),
  );
  const sent = stubFetch((request) =>
    request.method === "GET" && new URL(request.url).pathname === "/"
      ? listed(escaped)
      : storedResponse("body"),
  );
  const storage = s3Storage(options());

  const page = await storage.list({ prefix: "Grüße #1 +%?" }).page();

  expect(sent[0]?.url).toContain("prefix=Gr%C3%BC%C3%9Fe%20%231%20%2B%25%3F");
  expect(page.objects.map((entry) => entry.key)).toEqual(keys);

  for (const entry of page.objects) {
    // oxlint-disable-next-line no-await-in-loop -- one request at a time keeps `sent` in order
    await storage.stat(entry.key);
  }

  expect(sent.slice(1).map((request) => new URL(request.url).pathname)).toEqual([
    "/a%23b",
    "/100%25",
    "/q%3Fx%3D1",
    "/a%2Bb",
    "/hello%20world.txt",
    "/it%27s",
    "/a%26b%3Cc%3E",
    "/Gr%C3%BC%C3%9Fe/%E6%97%A5%E6%9C%AC%E8%AA%9E/%D0%BA%D0%BB%D1%8E%D1%87.txt",
  ]);
});

// Spec 4.6: keys written by another tool appear as they are, including a key ending in
// `/` and one longer than a writable key may be, and the addressable operations take them.
test("keys another tool wrote are listed as they are and are readable", async () => {
  const folder = "photos/";
  const long = `${"x".repeat(200)}/`.repeat(6);
  const sent = stubFetch((request) =>
    new URL(request.url).pathname === "/" ? listed([folder, long]) : storedResponse(""),
  );
  const storage = s3Storage(options());
  const listedKeys: string[] = [];

  for await (const entry of storage.list()) listedKeys.push(entry.key);

  expect(listedKeys).toEqual([folder, long]);
  expect(new TextEncoder().encode(long).length).toBeGreaterThan(1024);

  await expect(storage.stat(folder)).resolves.toMatchObject({ key: folder });
  await expect(storage.exists(long)).resolves.toBe(true);
  await expect((await storage.get(long)).text()).resolves.toBe("");
  expect(sent).toHaveLength(4);
});

test("a listing answer outside the parser's subset is a `ProviderError`", async () => {
  stubFetch(
    () =>
      new Response("<ListBucketResult><![CDATA[x]]></ListBucketResult>", {
        status: 200,
        headers: { "content-type": "application/xml", "x-amz-request-id": "listing-request" },
      }),
  );

  const failure = await rejection(async () => await s3Storage(options()).list().page());

  expect(failure.code).toBe("ProviderError");
  expect(failure.operation).toBe("list");
  // Spec 7.9: an error that carries a response names it, which traces it at the provider.
  expect(failure.status).toBe(200);
  expect(failure.requestId).toBe("listing-request");
});

test("a listing answer that breaks while it is read is a `NetworkError`", async () => {
  stubFetch(() => brokenBody(new TypeError("terminated")));

  const failure = await rejection(async () => await s3Storage(options()).list().page());

  expect(failure.code).toBe("NetworkError");
  expect(failure.operation).toBe("list");
  expect(failure.retryable).toBe(true);
  expect(failure.status).toBe(200);
  expect(failure.requestId).toBe("broken-request");
});

test("a listing whose signal already fired sends nothing", async () => {
  const sent = stubFetch(() => listed([]));

  await expect(s3Storage(options()).list({ signal: AbortSignal.abort() }).page()).rejects.toThrow(
    expect.objectContaining({ name: "AbortError" }),
  );
  expect(sent).toHaveLength(0);
});

// Spec 4.10: an abort produces the runtime's `AbortError` and never a `StorageError`,
// also where it lands while the answer is read.
test("an abort while the listing is read rejects with `AbortError`", async () => {
  stubFetch(() => brokenBody(new DOMException("The operation was aborted", "AbortError")));

  await expect(s3Storage(options()).list().page()).rejects.toThrow(
    expect.objectContaining({ name: "AbortError" }),
  );
});

test("an iteration handed a cursor walks on from where it points", async () => {
  const sent = stubFetch((request) =>
    queryOf(request)["continuation-token"] === undefined
      ? listed(["a"], { nextToken: "second" })
      : listed(["b"]),
  );
  const storage = s3Storage(options());
  const { cursor } = await storage.list().page();
  const keys: string[] = [];

  for await (const entry of storage.list({ cursor })) keys.push(entry.key);

  expect(keys).toEqual(["b"]);
  expect(queryOf(sent[1])["continuation-token"]).toBe("second");
});

test("an iteration rejects a provider repeating the continuation token it was sent", async () => {
  const sent = stubFetch(() => listed(["a"], { nextToken: "again" }));
  const storage = s3Storage(options());
  const keys: string[] = [];

  const failure = await rejection(async () => {
    for await (const entry of storage.list()) keys.push(entry.key);
  });

  expect(failure.code).toBe("ProviderError");
  expect(failure.operation).toBe("list");
  expect(keys).toEqual(["a"]);
  expect(sent).toHaveLength(2);
  expect(queryOf(sent[1])["continuation-token"]).toBe("again");
});

/** What a provider answers `DeleteObjects` with under `Quiet`: the keys it failed alone. */
function deleteResult(
  errors: readonly { key: string; code: string; message: string }[] = [],
): Response {
  const entries = errors
    .map(
      ({ key, code, message }) =>
        `<Error><Key>${key}</Key><Code>${code}</Code><Message>${message}</Message></Error>`,
    )
    .join("");

  return new Response(
    `<?xml version="1.0" encoding="UTF-8"?>\n<DeleteResult xmlns="http://s3.amazonaws.com/doc/2006-03-01/">${entries}</DeleteResult>`,
    {
      status: 200,
      headers: { "content-type": "application/xml", "x-amz-request-id": "delete-request" },
    },
  );
}

async function bodyText(request: SentRequest | undefined): Promise<string> {
  return await new Response(request?.body).text();
}

/** The keys a `DeleteObjects` body names, in the order it names them. */
async function deletedKeys(request: SentRequest | undefined): Promise<string[]> {
  const body = await bodyText(request);

  return [...body.matchAll(/<Key>([^<]*)<\/Key>/gu)].map((found) => found[1] ?? "");
}

test("`delete` of no key sends nothing and reports nothing", async () => {
  const sent = stubFetch(() => deleteResult());

  expect(await s3Storage(options()).delete()).toEqual({ requested: 0, failed: [] });
  expect(sent).toHaveLength(0);
});

test("`delete` sends one `DeleteObjects` for the keys, quiet and with its MD5", async () => {
  const sent = stubFetch(() => deleteResult());

  const report = await s3Storage(options()).delete("one.txt", "two.txt");
  const body = await bodyText(sent[0]);

  expect(report).toEqual({ requested: 2, failed: [] });
  expect(sent).toHaveLength(1);
  expect(sent[0]?.method).toBe("POST");
  expect(sent[0]?.url).toBe("https://stowage.s3.eu-central-1.amazonaws.com/?delete=");
  expect(body).toBe(
    '<?xml version="1.0" encoding="UTF-8"?><Delete><Quiet>true</Quiet><Object><Key>one.txt</Key></Object><Object><Key>two.txt</Key></Object></Delete>',
  );
  expect(sent[0]?.headers.get("content-md5")).toBe(md5Base64(new TextEncoder().encode(body)));
  expect(sent[0]?.headers.get("authorization")).toContain("content-md5");
});

test("a key is escaped where it stands in the XML", async () => {
  const sent = stubFetch(() => deleteResult());

  await s3Storage(options()).delete(`a&b<c>d"e'f`);

  expect(await bodyText(sent[0])).toContain("<Key>a&amp;b&lt;c&gt;d&quot;e&apos;f</Key>");
});

test("`delete` sends one request per 1000 keys", async () => {
  const sent = stubFetch(() => deleteResult());
  const keys = Array.from({ length: 2001 }, (_, index) => `object-${index}.txt`);

  const report = await s3Storage(options()).delete(...keys);

  expect(report).toEqual({ requested: 2001, failed: [] });
  expect(sent).toHaveLength(3);
  expect(await deletedKeys(sent[0])).toHaveLength(1000);
  expect(await deletedKeys(sent[1])).toHaveLength(1000);
  expect(await deletedKeys(sent[2])).toEqual(["object-2000.txt"]);
});

test("an invalid key is reported as `InvalidKey` and never sent", async () => {
  const sent = stubFetch(() => deleteResult());

  const report = await s3Storage(options()).delete("one.txt", "../escape", "two.txt");

  expect(report.requested).toBe(3);
  expect(report.failed).toHaveLength(1);
  expect(report.failed[0]).toMatchObject({
    code: "InvalidKey",
    key: "../escape",
    operation: "delete",
    attempts: 0,
  });
  expect(await deletedKeys(sent[0])).toEqual(["one.txt", "two.txt"]);
});

test("a call holding invalid keys alone sends nothing", async () => {
  const sent = stubFetch(() => deleteResult());

  const report = await s3Storage(options()).delete("/leading", "a//b");

  expect(report.requested).toBe(2);
  expect(report.failed.map((failure) => failure.key)).toEqual(["/leading", "a//b"]);
  expect(sent).toHaveLength(0);
});

// A lone surrogate has no UTF-8 form, and the encoder would send U+FFFD in its place: a
// request naming another object than the one the caller asked to delete.
test("a key holding a lone surrogate is reported rather than sent as another key", async () => {
  const sent = stubFetch(() => deleteResult());

  const report = await s3Storage(options()).delete("broken-\uD800.txt");

  expect(report.failed[0]).toMatchObject({ code: "InvalidKey", key: "broken-\uD800.txt" });
  expect(sent).toHaveLength(0);
});

test("a key the provider failed is reported with its code, and not repeated", async () => {
  const sent = stubFetch(() =>
    deleteResult([
      { key: "denied.txt", code: "AccessDenied", message: "Access Denied" },
      { key: "busy.txt", code: "InternalError", message: "We encountered an internal error" },
    ]),
  );

  const report = await s3Storage(options()).delete("denied.txt", "busy.txt", "fine.txt");

  expect(sent).toHaveLength(1);
  expect(report.requested).toBe(3);
  expect(report.failed).toHaveLength(2);
  expect(report.failed[0]).toMatchObject({
    code: "AccessDenied",
    key: "denied.txt",
    operation: "delete",
    providerCode: "AccessDenied",
    message: "Access Denied",
    requestId: "delete-request",
    retryable: false,
    attempts: 1,
  });
  expect(report.failed[1]).toMatchObject({
    code: "ProviderError",
    key: "busy.txt",
    providerCode: "InternalError",
    retryable: true,
  });
});

test("a failed key the provider does not name is a `ProviderError`", async () => {
  stubFetch(
    () =>
      new Response(
        `<?xml version="1.0" encoding="UTF-8"?>\n<DeleteResult><Error><Code>AccessDenied</Code><Message>Access Denied</Message></Error></DeleteResult>`,
        { status: 200 },
      ),
  );

  const failure = await rejection(async () => await s3Storage(options()).delete("one.txt"));

  expect(failure).toMatchObject({ code: "ProviderError", operation: "delete" });
});

test("a failure of the request as a whole rejects instead of filling the report", async () => {
  stubFetch(() => refused(403, "AccessDenied", "Access Denied"));

  const failure = await rejection(async () => await s3Storage(options()).delete("one.txt"));

  expect(failure.code).toBe("AccessDenied");
  expect(failure.operation).toBe("delete");
  expect(failure.key).toBeUndefined();
});

test("a transient failure of the request as a whole is repeated on the budget", async () => {
  recordedDelays();
  const answers = [refused(503, "SlowDown", "Reduce your request rate"), deleteResult()];
  const sent = stubFetch(() => answers.shift() ?? deleteResult());

  expect(await s3Storage(options()).delete("one.txt")).toEqual({ requested: 1, failed: [] });
  expect(sent).toHaveLength(2);
});

test("a deletion that failed inside a `200` rejects with the provider's error", async () => {
  const sent = stubFetch(
    () =>
      new Response(
        `<?xml version="1.0" encoding="UTF-8"?>\n<Error><Code>InternalError</Code><Message>We encountered an internal error.</Message></Error>`,
        { status: 200 },
      ),
  );

  const failure = await rejection(async () => await s3Storage(options()).delete("one.txt"));

  expect(failure).toMatchObject({
    code: "ProviderError",
    operation: "delete",
    providerCode: "InternalError",
    retryable: true,
  });
  expect(sent).toHaveLength(1);
});

test("an answer that is no `DeleteResult` is a `ProviderError`", async () => {
  stubFetch(() => listed([]));

  const failure = await rejection(async () => await s3Storage(options()).delete("one.txt"));

  expect(failure.code).toBe("ProviderError");
  expect(failure.operation).toBe("delete");
});

test("`deleteAll` lists below the prefix and deletes each page as it arrives", async () => {
  const sent = stubFetch((request) => {
    if (request.method === "POST") return deleteResult();

    return queryOf(request)["continuation-token"] === undefined
      ? listed(["a/one.txt", "a/two.txt"], { nextToken: "page-2" })
      : listed(["a/three.txt"]);
  });

  const report = await s3Storage(options()).deleteAll("a/");

  expect(report).toEqual({ requested: 3, failed: [] });
  expect(sent.map((request) => request.method)).toEqual(["GET", "POST", "GET", "POST"]);
  expect(queryOf(sent[0])).toMatchObject({ "list-type": "2", prefix: "a/", "max-keys": "1000" });
  expect(await deletedKeys(sent[1])).toEqual(["a/one.txt", "a/two.txt"]);
  expect(queryOf(sent[2])["continuation-token"]).toBe("page-2");
  expect(await deletedKeys(sent[3])).toEqual(["a/three.txt"]);
});

test("`deleteAll` below an empty prefix sends one listing and deletes nothing", async () => {
  const sent = stubFetch(() => listed([]));

  expect(await s3Storage(options()).deleteAll("empty/")).toEqual({ requested: 0, failed: [] });
  expect(sent).toHaveLength(1);
});

test("`deleteAll` reports what it could not delete", async () => {
  stubFetch((request) =>
    request.method === "POST"
      ? deleteResult([{ key: "a/one.txt", code: "AccessDenied", message: "Access Denied" }])
      : listed(["a/one.txt", "a/two.txt"]),
  );

  const report = await s3Storage(options()).deleteAll("a/");

  expect(report.requested).toBe(2);
  expect(report.failed).toHaveLength(1);
  expect(report.failed[0]).toMatchObject({ key: "a/one.txt", operation: "deleteAll" });
});

test("`deleteAll` rejects with a failure of the listing, told as its own", async () => {
  stubFetch(() => refused(403, "AccessDenied", "Access Denied"));

  const failure = await rejection(async () => await s3Storage(options()).deleteAll("a/"));

  expect(failure.code).toBe("AccessDenied");
  expect(failure.operation).toBe("deleteAll");
});

test("`deleteAll` refuses an invalid prefix before any request", async () => {
  const sent = stubFetch(() => listed([]));

  const failure = await rejection(async () => await s3Storage(options()).deleteAll("/leading"));

  expect(failure.code).toBe("InvalidKey");
  expect(sent).toHaveLength(0);
});

test("`deleteAll` rejects before any request where the signal already fired", async () => {
  const sent = stubFetch(() => listed([]));

  await expect(
    s3Storage(options()).deleteAll("a/", { signal: AbortSignal.abort() }),
  ).rejects.toThrow(expect.objectContaining({ name: "AbortError" }));
  expect(sent).toHaveLength(0);
});

/** What a provider answers a `CopyObject` it carried out with. */
function copied(): Response {
  return new Response(
    `<?xml version="1.0" encoding="UTF-8"?>\n<CopyObjectResult><LastModified>2026-09-23T08:00:00.000Z</LastModified><ETag>"copied"</ETag></CopyObjectResult>`,
    { status: 200, headers: { "content-type": "application/xml" } },
  );
}

/** The destination as a `HEAD` describes it once the copy landed. */
function copiedStat(): Response {
  return new Response(null, {
    status: 200,
    headers: {
      "content-length": "13",
      "content-type": "text/plain",
      "last-modified": "Wed, 23 Sep 2026 08:00:00 GMT",
      etag: '"copied"',
      "x-amz-meta-written-by": "stowage",
    },
  });
}

/** A `CopyObject` answered, the `HEAD` after it and a `DELETE`, each as S3 answers it. */
function copyingProvider(request: SentRequest): Response {
  if (request.method === "PUT") return copied();
  if (request.method === "HEAD") return copiedStat();

  return new Response(null, { status: 204 });
}

test("`copy` sends `CopyObject` naming the source and describes the destination", async () => {
  const sent = stubFetch(copyingProvider);

  const written = await s3Storage(options()).copy("from.txt", "to.txt");

  expect(sent.map((request) => request.method)).toEqual(["PUT", "HEAD"]);
  expect(sent[0]?.url).toBe("https://stowage.s3.eu-central-1.amazonaws.com/to.txt");
  expect(sent[0]?.headers.get("x-amz-copy-source")).toBe("/stowage/from.txt");
  expect(sent[0]?.headers.get("authorization")).toContain("x-amz-copy-source");
  // Spec 4.11 keeps the source's content type and user metadata, which S3's default
  // directive does and a `REPLACE` would not.
  expect(sent[0]?.headers.get("x-amz-metadata-directive")).toBeNull();
  expect(sent[0]?.headers.get("content-type")).toBeNull();
  expect(sent[1]?.url).toBe("https://stowage.s3.eu-central-1.amazonaws.com/to.txt");
  expect(written).toMatchObject({
    key: "to.txt",
    size: 13,
    contentType: "text/plain",
    etag: "copied",
    userMetadata: { "written-by": "stowage" },
  });
});

test("the source is percent-encoded segment by segment in `x-amz-copy-source`", async () => {
  const sent = stubFetch(copyingProvider);

  await s3Storage(options()).copy("a b/ü#?.txt", "to.txt");

  expect(sent[0]?.headers.get("x-amz-copy-source")).toBe("/stowage/a%20b/%C3%BC%23%3F.txt");
});

test("a missing source is `NotFound` naming the source", async () => {
  const sent = stubFetch(() => refused(404, "NoSuchKey", "The specified key does not exist."));

  const failure = await rejection(
    async () => await s3Storage(options()).copy("from.txt", "to.txt"),
  );

  expect(failure).toMatchObject({ code: "NotFound", operation: "copy", key: "from.txt" });
  expect(sent).toHaveLength(1);
});

// Spec 7.8 and ADR 0016: the provider's refusal is the answer, and no `UploadPartCopy`
// follows against a source nothing pins.
test("a source the provider refuses as too large rejects with its error and nothing more", async () => {
  const message =
    "The specified copy source is larger than the maximum allowable size for a copy source: 5368709120";
  const sent = stubFetch(() => refused(400, "InvalidRequest", message));

  const failure = await rejection(
    async () => await s3Storage(options()).copy("from.txt", "to.txt"),
  );

  expect(failure).toMatchObject({
    code: "ProviderError",
    status: 400,
    providerCode: "InvalidRequest",
    message,
    retryable: false,
  });
  expect(sent).toHaveLength(1);
});

test("a copy that failed inside a `200` rejects with the provider's error", async () => {
  const sent = stubFetch(
    () =>
      new Response(
        `<?xml version="1.0" encoding="UTF-8"?>\n<Error><Code>InternalError</Code><Message>We encountered an internal error. Please try again.</Message></Error>`,
        { status: 200, headers: { "x-amz-request-id": "copy-request" } },
      ),
  );

  const failure = await rejection(
    async () => await s3Storage(options()).copy("from.txt", "to.txt"),
  );

  expect(failure).toMatchObject({
    code: "ProviderError",
    operation: "copy",
    key: "to.txt",
    status: 200,
    providerCode: "InternalError",
    requestId: "copy-request",
    message: "We encountered an internal error. Please try again.",
    retryable: true,
    attempts: 1,
  });
  expect(sent).toHaveLength(1);
});

test("an answer to a copy that is no `CopyObjectResult` is a `ProviderError`", async () => {
  stubFetch(() => listed([]));

  const failure = await rejection(
    async () => await s3Storage(options()).copy("from.txt", "to.txt"),
  );

  expect(failure).toMatchObject({ code: "ProviderError", operation: "copy" });
});

test.each([
  ["copy", "from.txt", "ends-in-a-slash/"],
  ["copy", "../from.txt", "to.txt"],
  ["move", "from.txt", "ends-in-a-slash/"],
  ["move", "../from.txt", "to.txt"],
] as const)(
  "`%s` refuses an invalid key on either side before any request",
  async (operation, from, to) => {
    const sent = stubFetch(copyingProvider);

    const failure = await rejection(async () => await s3Storage(options())[operation](from, to));

    expect(failure).toMatchObject({ code: "InvalidKey", operation, attempts: 0 });
    expect(sent).toHaveLength(0);
  },
);

test("`move` copies, describes the destination and then deletes the source", async () => {
  const sent = stubFetch(copyingProvider);

  const written = await s3Storage(options()).move("from.txt", "to.txt");

  expect(sent.map((request) => request.method)).toEqual(["PUT", "HEAD", "DELETE"]);
  expect(sent[2]?.url).toBe("https://stowage.s3.eu-central-1.amazonaws.com/from.txt");
  expect(written).toMatchObject({ key: "to.txt", size: 13 });
});

test("`move` of a key onto itself is `InvalidRequest` and deletes nothing", async () => {
  const sent = stubFetch(copyingProvider);

  const failure = await rejection(
    async () => await s3Storage(options()).move("same.txt", "same.txt"),
  );

  expect(failure).toMatchObject({ code: "InvalidRequest", operation: "move", attempts: 0 });
  expect(sent).toHaveLength(0);
});

test("`move` whose copy fails deletes nothing and throws the copy's error", async () => {
  const sent = stubFetch(() => refused(404, "NoSuchKey", "The specified key does not exist."));

  const failure = await rejection(
    async () => await s3Storage(options()).move("from.txt", "to.txt"),
  );

  expect(failure).toMatchObject({ code: "NotFound", operation: "move", key: "from.txt" });
  expect(sent).toHaveLength(1);
});

test("`move` whose delete fails throws the delete's error", async () => {
  const sent = stubFetch((request) =>
    request.method === "DELETE"
      ? refused(403, "AccessDenied", "Access Denied")
      : copyingProvider(request),
  );

  const failure = await rejection(
    async () => await s3Storage(options()).move("from.txt", "to.txt"),
  );

  expect(failure).toMatchObject({ code: "AccessDenied", operation: "move", key: "from.txt" });
  expect(sent.map((request) => request.method)).toEqual(["PUT", "HEAD", "DELETE"]);
});

test("`copy` rejects before any request where the signal already fired", async () => {
  const sent = stubFetch(copyingProvider);

  await expect(
    s3Storage(options()).copy("from.txt", "to.txt", { signal: AbortSignal.abort() }),
  ).rejects.toThrow(expect.objectContaining({ name: "AbortError" }));
  expect(sent).toHaveLength(0);
});

/** Every operation answered as S3 answers it, told apart by what the request carries. */
function answeringProvider(request: SentRequest): Response {
  const query = queryOf(request);

  if (request.method === "POST" && "delete" in query) return deleteResult();
  if (request.method === "GET" && "list-type" in query) return listed(["object.txt"]);
  if (request.method === "PUT" && request.headers.has("x-amz-copy-source")) return copied();
  if (request.method === "PUT") return accepted();
  if (request.method === "HEAD") return copiedStat();
  if (request.method === "GET") return storedResponse("stored");

  return new Response(null, { status: 204 });
}

// Spec 7.4: `UNSIGNED-PAYLOAD` belongs to a presigned URL alone, so every request the
// adapter sends itself carries the SHA-256 of its body, and none signs through the query.
test("no operation sends `UNSIGNED-PAYLOAD` or a signature in the query", async () => {
  const sent = stubFetch(answeringProvider);
  const storage = s3Storage(options());

  await storage.put("object.txt", "body");
  await storage.put("streamed.txt", new Blob(["streamed"]).stream());
  await (await storage.get("object.txt")).text();
  await storage.stat("object.txt");
  await storage.exists("object.txt");
  await storage.list().page();
  await storage.delete("object.txt");
  await storage.deleteAll("folder/");
  await storage.copy("object.txt", "copy.txt");
  await storage.move("copy.txt", "moved.txt");

  expect(new Set(sent.map((request) => request.method))).toEqual(
    new Set(["PUT", "GET", "HEAD", "POST", "DELETE"]),
  );

  for (const request of sent) {
    expect(request.headers.get("x-amz-content-sha256")).toMatch(/^[\da-f]{64}$/u);
    expect(request.headers.get("authorization")).toMatch(/^AWS4-HMAC-SHA256 /u);
    expect(Object.keys(queryOf(request)).filter((name) => name.startsWith("X-Amz-"))).toEqual([]);
  }
});
