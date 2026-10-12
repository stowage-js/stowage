import { isStorageError, type StorageError } from "@stowage/core";
import { afterEach, expect, test, vi } from "vitest";

import { type S3AdapterOptions, s3Storage } from "./index.ts";

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

interface SentRequest {
  readonly url: URL;
  readonly method: string;
  readonly headers: Headers;
  readonly body: string | undefined;
  readonly signal: AbortSignal | undefined;
}

type Answer = (request: SentRequest) => Response | Promise<Response>;

/** What `fetch` was called with, in order, while it answered `answer`. */
function stubFetch(answer: Answer): SentRequest[] {
  const sent: SentRequest[] = [];

  vi.stubGlobal("fetch", async (url: string, init: RequestInit): Promise<Response> => {
    const request: SentRequest = {
      url: new URL(url),
      method: init.method ?? "GET",
      headers: new Headers(init.headers),
      body: init.body instanceof Uint8Array ? new TextDecoder().decode(init.body) : undefined,
      signal: init.signal ?? undefined,
    };

    sent.push(request);

    return await answer(request);
  });

  return sent;
}

/** The headers SigV4 signed on the request, read off its `Authorization`. */
function signedHeadersOf(request: SentRequest | undefined): string[] {
  const authorization = request?.headers.get("authorization") ?? "";

  return /SignedHeaders=([^,]+)/u.exec(authorization)?.[1]?.split(";") ?? [];
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

test('`put` with `onlyIf: "absent"` sends `If-None-Match: *` on `PutObject`, signed', async () => {
  const sent = stubFetch(accepted);

  await s3Storage(options()).put("object.txt", "body", { onlyIf: "absent" });

  expect(sent).toHaveLength(1);
  expect(sent[0]?.headers.get("if-none-match")).toBe("*");
  expect(signedHeadersOf(sent[0])).toContain("if-none-match");
});

test("`put` without `onlyIf` sends no precondition", async () => {
  const sent = stubFetch(accepted);

  await s3Storage(options()).put("object.txt", "body");

  expect(sent[0]?.headers.has("if-none-match")).toBe(false);
});

/** The error document a provider answers every failed request but a `HEAD` with. */
function refused(status: number, code: string, message = "Refused"): Response {
  return new Response(
    `<?xml version="1.0" encoding="UTF-8"?>\n<Error><Code>${code}</Code><Message>${message}</Message><RequestId>abc</RequestId></Error>`,
    { status, headers: { "content-type": "application/xml", "x-amz-request-id": "abc" } },
  );
}

/** Every wait between two attempts cut to nothing, so a spent budget costs no time. */
function immediateRetries(): void {
  const fire = globalThis.setTimeout;

  vi.stubGlobal("setTimeout", (handler: () => void): unknown => fire(handler, 0));
}

const preconditionFailed = (): Response =>
  refused(
    412,
    "PreconditionFailed",
    "At least one of the pre-conditions you specified did not hold",
  );

test("`put` onto a key that holds an object rejects with `PreconditionFailed`, not repeated", async () => {
  const sent = stubFetch(preconditionFailed);

  const failure = await rejection(() =>
    s3Storage(options()).put("object.txt", "body", { onlyIf: "absent" }),
  );

  expect(failure).toMatchObject({
    code: "PreconditionFailed",
    operation: "put",
    key: "object.txt",
    status: 412,
    providerCode: "PreconditionFailed",
    retryable: false,
    attempts: 1,
  });
  expect(sent).toHaveLength(1);
});

// ADR 0071: AWS's answer to a multipart commit another writer overtook, which leaves the
// caller the same way out as a `412`.
test("`ConditionalRequestConflict` is `PreconditionFailed`", async () => {
  stubFetch(() => refused(409, "ConditionalRequestConflict"));

  const failure = await rejection(() =>
    s3Storage(options()).put("object.txt", "body", { onlyIf: "absent" }),
  );

  expect(failure).toMatchObject({
    code: "PreconditionFailed",
    status: 409,
    providerCode: "ConditionalRequestConflict",
    retryable: false,
  });
});

/** A provider that answers the attempts in turn, the last answer standing for every later one. */
function answeringInTurn(...answers: readonly (() => Response)[]): Answer {
  let attempt = 0;

  return () => {
    const answer = answers[Math.min(attempt, answers.length - 1)];

    attempt += 1;

    if (answer === undefined) throw new Error("No answer given");

    return answer();
  };
}

function noResponse(): Response {
  throw new TypeError("fetch failed");
}

// Spec 7.5 and ADR 0073: a repeat of a write that went through meets its own object, so
// the refusal after a lost answer is that answer's doubt and not another writer's object.
test.each([
  ["no response", noResponse, "NetworkError", undefined],
  ["a `503`", () => refused(503, "SlowDown"), "ProviderError", 503],
] as const)(
  "a conditional `PutObject` refused after %s rejects with that failure",
  async (_, first, code, status) => {
    immediateRetries();

    const sent = stubFetch(answeringInTurn(first, preconditionFailed));

    const failure = await rejection(() =>
      s3Storage(options()).put("object.txt", "body", { onlyIf: "absent" }),
    );

    expect(failure).toMatchObject({ code, status, retryable: true, attempts: 2 });
    expect(sent).toHaveLength(2);
  },
);

test.each([
  ["a `408`", () => refused(408, "RequestTimeout")],
  ["a `429`", () => refused(429, "TooManyRequests")],
] as const)(
  "a conditional `PutObject` refused after %s stays `PreconditionFailed`",
  async (_, first) => {
    immediateRetries();

    stubFetch(answeringInTurn(first, preconditionFailed));

    const failure = await rejection(() =>
      s3Storage(options()).put("object.txt", "body", { onlyIf: "absent" }),
    );

    expect(failure).toMatchObject({ code: "PreconditionFailed", status: 412, attempts: 2 });
  },
);

const mebibyte = 1024 * 1024;

/** The smallest part spec 7.1 accepts, which keeps a multipart upload cheap to stub. */
const smallestPart = 5 * mebibyte;

/** A stream that fills two parts of `smallestPart`, which makes `put` a multipart upload. */
function twoParts(): ReadableStream<Uint8Array> {
  const bytes = new Uint8Array(smallestPart + 1);
  let pulled = 0;

  return new ReadableStream({
    pull(controller) {
      if (pulled >= bytes.byteLength) {
        controller.close();
        return;
      }

      const end = Math.min(pulled + mebibyte, bytes.byteLength);

      controller.enqueue(bytes.subarray(pulled, end));
      pulled = end;
    },
  });
}

/** The request of a multipart upload a `SentRequest` is, read off its method and query. */
function stepOf(request: SentRequest): string {
  const query = request.url.searchParams;

  if (request.method === "POST" && query.has("uploads")) return "create";
  if (request.method === "PUT" && query.has("partNumber")) return "part";
  if (request.method === "POST" && query.has("uploadId")) return "complete";
  if (request.method === "DELETE" && query.has("uploadId")) return "abort";

  return `${request.method} ${request.url.pathname}`;
}

function xmlAnswer(document: string): Response {
  return new Response(`<?xml version="1.0" encoding="UTF-8"?>\n${document}`, {
    status: 200,
    headers: { "content-type": "application/xml", date: "Sun, 30 Aug 2015 12:36:00 GMT" },
  });
}

const s3Namespace = "http://s3.amazonaws.com/doc/2006-03-01/";

/** What a provider answers each request of a multipart upload with, where it accepts it. */
function multipartProvider(overrides: Partial<Record<string, Answer>> = {}): Answer {
  return async (request) => {
    const step = stepOf(request);
    const override = overrides[step];

    if (override !== undefined) return await override(request);

    switch (step) {
      case "create":
        return xmlAnswer(
          `<InitiateMultipartUploadResult xmlns="${s3Namespace}"><UploadId>upload-1</UploadId></InitiateMultipartUploadResult>`,
        );
      case "part":
        return new Response(null, { status: 200, headers: { etag: '"part"' } });
      case "complete":
        return xmlAnswer(
          `<CompleteMultipartUploadResult xmlns="${s3Namespace}"><ETag>&quot;assembled-2&quot;</ETag></CompleteMultipartUploadResult>`,
        );
      case "abort":
        return new Response(null, { status: 204 });
      default:
        throw new Error(`The stub answers no ${step}`);
    }
  };
}

function multipartStorage(): ReturnType<typeof s3Storage> {
  return s3Storage(options({ multipart: { partSize: smallestPart } }));
}

// Spec 7.4: AWS ignores a precondition on `CreateMultipartUpload` and refuses one on
// `UploadPart`, and R2 checks one at the start without carrying it to the commit.
test("a conditional multipart upload sends `If-None-Match: *` on its commit alone", async () => {
  const sent = stubFetch(multipartProvider());

  const written = await multipartStorage().put("object.bin", twoParts(), { onlyIf: "absent" });

  expect(written.etag).toBe("assembled-2");

  const complete = sent.find((request) => stepOf(request) === "complete");

  expect(complete?.headers.get("if-none-match")).toBe("*");
  expect(signedHeadersOf(complete)).toContain("if-none-match");
  expect(
    sent
      .filter((request) => stepOf(request) !== "complete")
      .map((request) => [stepOf(request), request.headers.has("if-none-match")]),
  ).toEqual([
    ["create", false],
    ["part", false],
    ["part", false],
  ]);
});

// Spec 7.6: AWS keeps a refused upload open, and a later commit without the header would
// commit it.
test("a commit its precondition refused aborts the upload without the caller's signal", async () => {
  const sent = stubFetch(multipartProvider({ complete: preconditionFailed }));

  const failure = await rejection(() =>
    multipartStorage().put("object.bin", twoParts(), {
      onlyIf: "absent",
      signal: new AbortController().signal,
    }),
  );

  expect(failure).toMatchObject({ code: "PreconditionFailed", key: "object.bin", attempts: 1 });
  expect(sent.map(stepOf).slice(-2)).toEqual(["complete", "abort"]);

  const abort = sent.at(-1);

  expect(abort?.signal).toBeUndefined();
  expect(abort?.headers.has("if-none-match")).toBe(false);
});

// The refusal says the commit did not happen, whenever the caller's signal fired.
test("a commit refused while the caller's signal fired still aborts the upload", async () => {
  const caller = new AbortController();
  const sent = stubFetch(
    multipartProvider({
      complete: () => {
        caller.abort();

        return preconditionFailed();
      },
    }),
  );

  const failure = await rejection(() =>
    multipartStorage().put("object.bin", twoParts(), { onlyIf: "absent", signal: caller.signal }),
  );

  expect(failure).toMatchObject({ code: "PreconditionFailed" });
  expect(sent.map(stepOf).at(-1)).toBe("abort");
  expect(sent.at(-1)?.signal).toBeUndefined();
});

test("an abort that fails after a refused commit is not reported", async () => {
  immediateRetries();

  stubFetch(
    multipartProvider({
      complete: preconditionFailed,
      abort: () => refused(500, "InternalError"),
    }),
  );

  const failure = await rejection(() =>
    multipartStorage().put("object.bin", twoParts(), { onlyIf: "absent" }),
  );

  expect(failure).toMatchObject({ code: "PreconditionFailed", status: 412 });
});

// Spec 7.5: AWS answers the repeat of a commit that went through `200`, R2 `NoSuchUpload`,
// and either refusal after a `5xx` may be the commit's own result.
test.each([
  ["`PreconditionFailed`", preconditionFailed],
  ["`NoSuchUpload`", () => refused(404, "NoSuchUpload", "The specified upload does not exist.")],
] as const)(
  "a conditional commit repeated after a `5xx` reads %s as that `5xx`",
  async (_, repeated) => {
    immediateRetries();

    const sent = stubFetch(
      multipartProvider({
        complete: answeringInTurn(() => refused(503, "SlowDown"), repeated),
      }),
    );

    const failure = await rejection(() =>
      multipartStorage().put("object.bin", twoParts(), { onlyIf: "absent" }),
    );

    expect(failure).toMatchObject({
      code: "ProviderError",
      status: 503,
      providerCode: "SlowDown",
      retryable: true,
      attempts: 2,
    });
    expect(sent.map(stepOf).filter((step) => step === "complete")).toHaveLength(2);
  },
);

// ADR 0073: that predates preconditions and stays as it was.
test("an unconditional commit repeated after a `5xx` reads `NoSuchUpload` as before", async () => {
  immediateRetries();

  stubFetch(
    multipartProvider({
      complete: answeringInTurn(
        () => refused(503, "SlowDown"),
        () => refused(404, "NoSuchUpload"),
      ),
    }),
  );

  const failure = await rejection(() => multipartStorage().put("object.bin", twoParts()));

  expect(failure).toMatchObject({
    code: "ProviderError",
    status: 404,
    providerCode: "NoSuchUpload",
  });
});

// Spec 7.7, with or without a precondition.
test("a conditional commit that received no response is neither repeated nor aborted", async () => {
  immediateRetries();

  const sent = stubFetch(multipartProvider({ complete: noResponse }));

  const failure = await rejection(() =>
    multipartStorage().put("object.bin", twoParts(), { onlyIf: "absent" }),
  );

  expect(failure).toMatchObject({ code: "NetworkError", retryable: true, attempts: 1 });
  expect(sent.map(stepOf).filter((step) => step === "complete")).toHaveLength(1);
  expect(sent.map(stepOf)).not.toContain("abort");
});

/** A `CopyObject` answered as S3 answers it. */
function copied(): Response {
  return xmlAnswer(
    `<CopyObjectResult xmlns="${s3Namespace}"><ETag>&quot;copied&quot;</ETag></CopyObjectResult>`,
  );
}

/** The `HEAD` that describes the destination of a copy. */
function copiedStat(): Response {
  return new Response(null, {
    status: 200,
    headers: {
      "content-length": "4",
      "content-type": "text/plain",
      "last-modified": "Sun, 30 Aug 2015 12:36:00 GMT",
      etag: '"copied"',
    },
  });
}

/** A `CopyObject`, the `HEAD` after it and a `DELETE`, each as S3 answers it. */
function copyingProvider(request: SentRequest): Response {
  if (request.method === "PUT") return copied();
  if (request.method === "HEAD") return copiedStat();

  return new Response(null, { status: 204 });
}

// Spec 7.8: AWS holds the one set and R2 the other, each ignoring the set it does not hold.
test.each(["copy", "move"] as const)(
  '`%s` with `onlyIf: "absent"` sends both sets of the precondition on `CopyObject`, signed',
  async (operation) => {
    const sent = stubFetch(copyingProvider);

    await s3Storage(options())[operation]("from.txt", "to.txt", { onlyIf: "absent" });

    const copy = sent[0];

    expect(copy?.method).toBe("PUT");
    expect(copy?.headers.get("if-none-match")).toBe("*");
    expect(copy?.headers.get("cf-copy-destination-if-none-match")).toBe("*");
    expect(signedHeadersOf(copy)).toEqual(
      expect.arrayContaining(["if-none-match", "cf-copy-destination-if-none-match"]),
    );

    // The `HEAD` that describes the destination, and the `DELETE` of the source of a `move`.
    for (const request of sent.slice(1)) {
      expect(request.headers.has("if-none-match")).toBe(false);
      expect(request.headers.has("cf-copy-destination-if-none-match")).toBe(false);
    }
  },
);

test("an unconditional `copy` sends neither set", async () => {
  const sent = stubFetch(copyingProvider);

  await s3Storage(options()).copy("from.txt", "to.txt");

  expect(sent[0]?.headers.has("if-none-match")).toBe(false);
  expect(sent[0]?.headers.has("cf-copy-destination-if-none-match")).toBe(false);
});

test.each(["copy", "move"] as const)(
  "`%s` refused at its destination is `PreconditionFailed` against `to`, and deletes nothing",
  async (operation) => {
    const sent = stubFetch(preconditionFailed);

    const failure = await rejection(() =>
      s3Storage(options())[operation]("from.txt", "to.txt", { onlyIf: "absent" }),
    );

    expect(failure).toMatchObject({
      code: "PreconditionFailed",
      operation,
      key: "to.txt",
      retryable: false,
      attempts: 1,
    });
    expect(sent.map((request) => request.method)).toEqual(["PUT"]);
  },
);

test("a conditional `CopyObject` refused after no response rejects with that failure", async () => {
  immediateRetries();

  stubFetch(answeringInTurn(noResponse, preconditionFailed));

  const failure = await rejection(() =>
    s3Storage(options()).copy("from.txt", "to.txt", { onlyIf: "absent" }),
  );

  expect(failure).toMatchObject({ code: "NetworkError", retryable: true, attempts: 2 });
});

test("a conditional `CopyObject` refused after a `503` rejects with that failure", async () => {
  immediateRetries();

  stubFetch(answeringInTurn(() => refused(503, "SlowDown"), preconditionFailed));

  const failure = await rejection(() =>
    s3Storage(options()).move("from.txt", "to.txt", { onlyIf: "absent" }),
  );

  expect(failure).toMatchObject({
    code: "ProviderError",
    status: 503,
    operation: "move",
    retryable: true,
    attempts: 2,
  });
});

/**
 * A bucket holding `keys`, which answers `CopyObject` under `If-None-Match: *` as AWS does
 * and refuses the first `deletesRefused` single-key `DELETE`s.
 */
function bucketHolding(
  keys: readonly string[],
  deletesRefused: number,
): {
  readonly held: Set<string>;
  readonly answer: Answer;
} {
  const held = new Set(keys);
  let refusals = deletesRefused;

  return {
    held,
    answer: (request) => {
      const key = decodeURIComponent(request.url.pathname.slice(1));

      if (request.method === "PUT") {
        if (request.headers.get("if-none-match") === "*" && held.has(key)) {
          return preconditionFailed();
        }

        held.add(key);

        return copied();
      }

      if (request.method === "HEAD") return copiedStat();

      if (request.method === "DELETE") {
        if (refusals > 0) {
          refusals -= 1;

          return refused(403, "AccessDenied", "Access Denied");
        }

        held.delete(key);

        return new Response(null, { status: 204 });
      }

      if (request.method === "POST" && request.url.searchParams.has("delete")) {
        for (const [, deleted] of request.body?.matchAll(/<Key>([^<]*)<\/Key>/gu) ?? []) {
          if (deleted !== undefined) held.delete(deleted);
        }

        return xmlAnswer(`<DeleteResult xmlns="${s3Namespace}"></DeleteResult>`);
      }

      throw new Error(`The stub answers no ${request.method} ${request.url.pathname}`);
    },
  };
}

// Spec 4.10 and ADR 0073: a conditional `move` repeated after its delete failed meets the
// destination it wrote, and `delete(from)` finishes it.
test("a conditional `move` whose delete failed is refused when repeated, and `delete` finishes it", async () => {
  const bucket = bucketHolding(["from.txt"], 1);
  const sent = stubFetch(bucket.answer);
  const storage = s3Storage(options());

  const deleteFailed = await rejection(() =>
    storage.move("from.txt", "to.txt", { onlyIf: "absent" }),
  );

  expect(deleteFailed).toMatchObject({ code: "AccessDenied", operation: "move", key: "from.txt" });
  expect(sent.find((request) => request.method === "DELETE")?.headers.has("if-none-match")).toBe(
    false,
  );
  expect([...bucket.held].toSorted()).toEqual(["from.txt", "to.txt"]);

  const repeated = await rejection(() => storage.move("from.txt", "to.txt", { onlyIf: "absent" }));

  expect(repeated).toMatchObject({ code: "PreconditionFailed", operation: "move", key: "to.txt" });
  expect([...bucket.held].toSorted()).toEqual(["from.txt", "to.txt"]);

  const report = await storage.delete("from.txt");

  expect(report).toMatchObject({ requested: 1, failed: [] });
  expect([...bucket.held]).toEqual(["to.txt"]);
});
