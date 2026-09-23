import { isStorageError, type StorageError } from "@stowage/core";
import { afterEach, expect, test, vi } from "vitest";

import { sha256Hex } from "./hash.ts";
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
