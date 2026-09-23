import { isStorageError, type StorageError } from "@stowage/core";
import { afterEach, expect, test, vi } from "vitest";

import { type S3AdapterOptions, s3Storage } from "./index.ts";

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

const kibibyte = 1024;
const mebibyte = 1024 * kibibyte;

/** The smallest part spec 7.1 accepts, which keeps a multipart upload cheap to stub. */
const smallestPart = 5 * mebibyte;

interface SentRequest {
  readonly url: URL;
  readonly method: string;
  readonly headers: Headers;
  readonly body: Uint8Array | undefined;
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
      body: init.body instanceof Uint8Array ? init.body : undefined,
      signal: init.signal ?? undefined,
    };

    sent.push(request);

    return await answer(request);
  });

  return sent;
}

/** What a provider answers `PutObject` with: an entity tag and the time it accepted it. */
function accepted(): Response {
  return new Response(null, {
    status: 200,
    headers: { etag: '"written"', date: "Sun, 30 Aug 2015 12:36:00 GMT" },
  });
}

/** Bytes that tell one offset from another, so a part sent twice or out of place shows. */
function patternOf(size: number): Uint8Array<ArrayBuffer> {
  const bytes = new Uint8Array(size);

  for (let index = 0; index < size; index += 1) bytes[index] = (index * 7) % 251;

  return bytes;
}

/** The bytes as a stream of `chunkSize` pieces, reporting what it handed out so far. */
function streamOf(
  bytes: Uint8Array,
  chunkSize: number,
  onPull?: (pulled: number) => void,
): ReadableStream<Uint8Array> {
  let pulled = 0;

  return new ReadableStream({
    pull(controller) {
      if (pulled >= bytes.byteLength) {
        controller.close();
        return;
      }

      const end = Math.min(pulled + chunkSize, bytes.byteLength);

      controller.enqueue(bytes.subarray(pulled, end));
      pulled = end;
      onPull?.(pulled);
    },
  });
}

/**
 * Where two byte sequences first differ, or `-1` where they are the same. `toEqual` walks
 * a typed array element by element and takes seconds over a part.
 */
function firstDifference(actual: Uint8Array | undefined, expected: Uint8Array): number {
  if (actual === undefined) return 0;

  const length = Math.min(actual.byteLength, expected.byteLength);

  for (let index = 0; index < length; index += 1) {
    if (actual[index] !== expected[index]) return index;
  }

  return actual.byteLength === expected.byteLength ? -1 : length;
}

const credentials = { accessKeyId: "AKIDEXAMPLE", secretAccessKey: "secret" };

function options(overrides: Partial<S3AdapterOptions> = {}): S3AdapterOptions {
  return { bucket: "stowage", region: "eu-central-1", credentials, ...overrides };
}

test("a stream that ends within one part goes as one `PUT`", async () => {
  const sent = stubFetch(accepted);
  const bytes = patternOf(64 * kibibyte);
  const body = streamOf(bytes, 4 * kibibyte);

  const written = await s3Storage(options()).put("object.bin", body);

  expect(sent).toHaveLength(1);
  expect(sent[0]?.method).toBe("PUT");
  expect(sent[0]?.url.search).toBe("");
  expect(firstDifference(sent[0]?.body, bytes)).toBe(-1);
  expect(written.size).toBe(bytes.byteLength);
  // Spec 4.2 leaves the stream at its end, with no reader holding it.
  expect(body.locked).toBe(false);
});

test("a stream that yields nothing goes as one empty `PUT`", async () => {
  const sent = stubFetch(accepted);

  const written = await s3Storage(options()).put("object.bin", streamOf(new Uint8Array(0), 1));

  expect(sent).toHaveLength(1);
  expect(sent[0]?.body?.byteLength).toBe(0);
  expect(written.size).toBe(0);
});

test("a stream of exactly one part goes as one `PUT`", async () => {
  const sent = stubFetch(accepted);
  const bytes = patternOf(smallestPart);

  await s3Storage(options({ multipart: { partSize: smallestPart } })).put(
    "object.bin",
    streamOf(bytes, mebibyte),
  );

  expect(sent.map((request) => request.method)).toEqual(["PUT"]);
  expect(firstDifference(sent[0]?.body, bytes)).toBe(-1);
});

const uploadId = "upload-1";

/** The request of a multipart upload a `SentRequest` is, read off its method and query. */
function stepOf(request: SentRequest): string {
  const query = request.url.searchParams;

  if (request.method === "POST" && query.has("uploads")) return "create";
  if (request.method === "PUT" && query.has("partNumber")) return `part ${query.get("partNumber")}`;
  if (request.method === "POST" && query.has("uploadId")) return "complete";
  if (request.method === "DELETE" && query.has("uploadId")) return "abort";

  return `${request.method} ${request.url.pathname}${request.url.search}`;
}

function xmlAnswer(document: string, headers: Record<string, string> = {}): Response {
  return new Response(`<?xml version="1.0" encoding="UTF-8"?>\n${document}`, {
    status: 200,
    headers: {
      "content-type": "application/xml",
      date: "Sun, 30 Aug 2015 12:36:00 GMT",
      ...headers,
    },
  });
}

/** What a provider answers each request of a multipart upload with, where it accepts it. */
function multipartProvider(overrides: Partial<Record<string, Answer>> = {}): Answer {
  return async (request) => {
    const step = stepOf(request);
    const override = overrides[step] ?? overrides[step.split(" ")[0] ?? ""];

    if (override !== undefined) return await override(request);

    if (step === "create") {
      return xmlAnswer(
        `<InitiateMultipartUploadResult xmlns="http://s3.amazonaws.com/doc/2006-03-01/"><Bucket>stowage</Bucket><Key>object.bin</Key><UploadId>${uploadId}</UploadId></InitiateMultipartUploadResult>`,
      );
    }

    if (step.startsWith("part ")) {
      return new Response(null, {
        status: 200,
        headers: { etag: `"etag-${request.url.searchParams.get("partNumber")}"` },
      });
    }

    if (step === "complete") {
      return xmlAnswer(
        `<CompleteMultipartUploadResult xmlns="http://s3.amazonaws.com/doc/2006-03-01/"><Location>https://stowage.s3.eu-central-1.amazonaws.com/object.bin</Location><Bucket>stowage</Bucket><Key>object.bin</Key><ETag>&quot;assembled-3&quot;</ETag></CompleteMultipartUploadResult>`,
      );
    }

    if (step === "abort") return new Response(null, { status: 204 });

    throw new Error(`The stub answers no ${step}`);
  };
}

/** The part requests of an upload, in part-number order. */
function partsOf(sent: readonly SentRequest[]): SentRequest[] {
  return sent
    .filter((request) => stepOf(request).startsWith("part "))
    .toSorted(
      (one, other) =>
        Number(one.url.searchParams.get("partNumber")) -
        Number(other.url.searchParams.get("partNumber")),
    );
}

/** The bytes the parts of an upload carried, concatenated in part-number order. */
function assembled(sent: readonly SentRequest[]): Uint8Array {
  const parts = partsOf(sent);
  const bytes = new Uint8Array(
    parts.reduce((size, part) => size + (part.body?.byteLength ?? 0), 0),
  );
  let offset = 0;

  for (const part of parts) {
    bytes.set(part.body ?? new Uint8Array(0), offset);
    offset += part.body?.byteLength ?? 0;
  }

  return bytes;
}

test("a stream that fills more than one part becomes a multipart upload", async () => {
  const sent = stubFetch(multipartProvider());
  const bytes = patternOf(2 * smallestPart + 3);
  const storage = s3Storage(options({ multipart: { partSize: smallestPart } }));

  const written = await storage.put("object.bin", streamOf(bytes, mebibyte), {
    contentType: "text/plain",
    userMetadata: { "Written-By": "stowage" },
  });

  // Parts in flight together reach the provider in no promised order.
  const steps = sent.map(stepOf);

  expect(steps.toSorted()).toEqual(["complete", "create", "part 1", "part 2", "part 3"]);
  expect(steps.at(0)).toBe("create");
  expect(steps.at(-1)).toBe("complete");

  const [create] = sent;
  const complete = sent.at(-1);
  const parts = partsOf(sent);

  // The object's content type and user metadata travel with the request that creates it.
  expect(create?.headers.get("content-type")).toBe("text/plain");
  expect(create?.headers.get("x-amz-meta-written-by")).toBe("stowage");
  expect(parts.map((part) => part.url.searchParams.get("uploadId"))).toEqual([
    uploadId,
    uploadId,
    uploadId,
  ]);
  expect(parts.map((part) => part.body?.byteLength)).toEqual([smallestPart, smallestPart, 3]);
  expect(firstDifference(assembled(sent), bytes)).toBe(-1);
  expect(complete?.url.searchParams.get("uploadId")).toBe(uploadId);
  expect(new TextDecoder().decode(complete?.body)).toBe(
    '<?xml version="1.0" encoding="UTF-8"?><CompleteMultipartUpload xmlns="http://s3.amazonaws.com/doc/2006-03-01/"><Part><PartNumber>1</PartNumber><ETag>&quot;etag-1&quot;</ETag></Part><Part><PartNumber>2</PartNumber><ETag>&quot;etag-2&quot;</ETag></Part><Part><PartNumber>3</PartNumber><ETag>&quot;etag-3&quot;</ETag></Part></CompleteMultipartUpload>',
  );
  // Nothing about the upload reaches the API: the description is the object's alone.
  expect(written).toEqual({
    key: "object.bin",
    size: bytes.byteLength,
    lastModified: new Date("Sun, 30 Aug 2015 12:36:00 GMT"),
    etag: "assembled-3",
    contentType: "text/plain",
    userMetadata: { "written-by": "stowage" },
  });
});

interface HeldParts {
  readonly answer: Answer;
  /** The most part requests that were in flight at once. */
  readonly mostInFlight: () => number;
  /** The bytes each part request found read out of the stream and not yet answered. */
  readonly heldAtEachPart: number[];
}

/**
 * Part requests held open until `concurrency` of them are waiting, so an upload that
 * sends them one by one shows as a single request in flight rather than as a race. A
 * request that finds fewer beside it goes on after a moment, which is the last parts.
 */
function heldParts(concurrency: number, pulled: () => number): HeldParts {
  let waiting: (() => void)[] = [];
  let inFlight = 0;
  let mostInFlight = 0;
  let answered = 0;
  const heldAtEachPart: number[] = [];
  const provider = multipartProvider();

  return {
    heldAtEachPart,
    mostInFlight: () => mostInFlight,
    async answer(request) {
      if (!stepOf(request).startsWith("part ")) return await provider(request);

      inFlight += 1;
      mostInFlight = Math.max(mostInFlight, inFlight);
      heldAtEachPart.push(pulled() - answered);

      await new Promise<void>((resolve) => {
        waiting.push(resolve);

        if (waiting.length >= concurrency) {
          for (const release of waiting) release();
          waiting = [];
        } else {
          setTimeout(resolve, 20);
        }
      });

      inFlight -= 1;
      answered += request.body?.byteLength ?? 0;

      return await provider(request);
    },
  };
}

test("parts go `concurrency` at a time, and the upload holds no more of the stream", async () => {
  let pulled = 0;
  const held = heldParts(2, () => pulled);
  const sent = stubFetch(held.answer);
  const bytes = patternOf(6 * smallestPart + 1);
  const storage = s3Storage(options({ multipart: { partSize: smallestPart, concurrency: 2 } }));

  await storage.put(
    "object.bin",
    streamOf(bytes, mebibyte, (total) => {
      pulled = total;
    }),
  );

  expect(firstDifference(assembled(sent), bytes)).toBe(-1);
  expect(held.mostInFlight()).toBe(2);
  // The parts in flight, and the chunk read ahead to learn whether the stream goes on
  // together with the one the stream itself queues in front of the next read.
  expect(Math.max(...held.heldAtEachPart)).toBeLessThanOrEqual(2 * smallestPart + 2 * mebibyte);
});

test("parts are 8 MiB and go four at a time by default", async () => {
  let pulled = 0;
  const held = heldParts(4, () => pulled);
  const sent = stubFetch(held.answer);
  const bytes = patternOf(5 * 8 * mebibyte + 1);

  await s3Storage(options()).put(
    "object.bin",
    streamOf(bytes, mebibyte, (total) => {
      pulled = total;
    }),
  );

  expect(partsOf(sent).map((part) => part.body?.byteLength)).toEqual([
    ...Array.from({ length: 5 }, () => 8 * mebibyte),
    1,
  ]);
  expect(held.mostInFlight()).toBe(4);
  expect(Math.max(...held.heldAtEachPart)).toBeLessThanOrEqual(4 * 8 * mebibyte + 2 * mebibyte);
});

async function rejection(act: () => Promise<unknown>): Promise<unknown> {
  try {
    await act();
  } catch (failure) {
    return failure;
  }

  throw new Error("The call resolved");
}

async function storageRejection(act: () => Promise<unknown>): Promise<StorageError> {
  const failure = await rejection(act);

  if (isStorageError(failure)) return failure;

  throw failure;
}

/** Every wait between two attempts cut to nothing, so a spent budget costs no time. */
function immediateRetries(): void {
  const fire = globalThis.setTimeout;

  vi.stubGlobal("setTimeout", (handler: () => void): unknown => fire(handler, 0));
}

/** A request that stays open until its signal fires, and then fails as `fetch` does. */
async function openUntilAborted(request: SentRequest): Promise<Response> {
  return await new Promise((_resolve, reject) => {
    const { signal } = request;

    if (signal?.aborted) reject(signal.reason);

    signal?.addEventListener("abort", () => reject(signal.reason), { once: true });
  });
}

function refused(status: number, code: string, message: string): Response {
  return new Response(
    `<?xml version="1.0" encoding="UTF-8"?>\n<Error><Code>${code}</Code><Message>${message}</Message><RequestId>abc</RequestId></Error>`,
    { status, headers: { "content-type": "application/xml", "x-amz-request-id": "abc" } },
  );
}

/** A long stream that notes whether it was canceled. */
function cancelableStream(size: number): {
  body: ReadableStream<Uint8Array>;
  canceled: () => boolean;
} {
  let canceled = false;
  const bytes = patternOf(size);
  let pulled = 0;

  return {
    canceled: () => canceled,
    body: new ReadableStream({
      pull(controller) {
        if (pulled >= bytes.byteLength) {
          controller.close();
          return;
        }

        controller.enqueue(bytes.subarray(pulled, pulled + mebibyte));
        pulled += mebibyte;
      },
      cancel() {
        canceled = true;
      },
    }),
  };
}

test("a part that spent its budget cancels the rest, aborts the upload and rejects with its error", async () => {
  immediateRetries();

  const sent = stubFetch(
    multipartProvider({
      "part 1": openUntilAborted,
      "part 2": () => refused(500, "InternalError", "We encountered an internal error."),
    }),
  );
  const source = cancelableStream(10 * smallestPart);
  const storage = s3Storage(options({ multipart: { partSize: smallestPart, concurrency: 2 } }));

  const failure = await storageRejection(() => storage.put("object.bin", source.body));

  expect(failure.code).toBe("ProviderError");
  expect(failure.status).toBe(500);
  expect(failure.message).toBe("We encountered an internal error.");
  expect(failure.attempts).toBe(3);
  expect(sent.map(stepOf).filter((step) => step === "part 2")).toHaveLength(3);
  expect(sent.find((request) => stepOf(request) === "part 1")?.signal?.aborted).toBe(true);
  expect(source.canceled()).toBe(true);

  const abort = sent.filter((request) => stepOf(request) === "abort");

  expect(abort).toHaveLength(1);
  expect(abort[0]?.url.searchParams.get("uploadId")).toBe(uploadId);
  expect(sent.map(stepOf)).not.toContain("complete");
  expect(sent.map(stepOf)).not.toContain("part 3");
});

test("the caller's abort cancels the parts, aborts the upload without a signal and rejects with `AbortError`", async () => {
  const controller = new AbortController();
  const sent = stubFetch(
    multipartProvider({
      part: async (request) => {
        controller.abort();

        return await openUntilAborted(request);
      },
    }),
  );
  const source = cancelableStream(10 * smallestPart);
  const storage = s3Storage(options({ multipart: { partSize: smallestPart } }));

  const failure = await rejection(() =>
    storage.put("object.bin", source.body, { signal: controller.signal }),
  );

  expect(isStorageError(failure)).toBe(false);
  expect(failure).toHaveProperty("name", "AbortError");
  expect(source.canceled()).toBe(true);
  expect(partsOf(sent).every((part) => part.signal?.aborted)).toBe(true);

  const abort = sent.filter((request) => stepOf(request) === "abort");

  expect(abort).toHaveLength(1);
  expect(abort[0]?.signal).toBeUndefined();
  expect(sent.map(stepOf)).not.toContain("complete");
});

test("an abort request that fails is not reported", async () => {
  immediateRetries();

  const controller = new AbortController();
  const sent = stubFetch(
    multipartProvider({
      part: async (request) => {
        controller.abort();

        return await openUntilAborted(request);
      },
      abort: () => {
        throw new TypeError("fetch failed");
      },
    }),
  );
  const storage = s3Storage(options({ multipart: { partSize: smallestPart } }));

  const failure = await rejection(() =>
    storage.put("object.bin", cancelableStream(3 * smallestPart).body, {
      signal: controller.signal,
    }),
  );

  expect(failure).toHaveProperty("name", "AbortError");
  // The abort went out on the budget of any request, and its last failure went nowhere.
  expect(sent.filter((request) => stepOf(request) === "abort")).toHaveLength(3);
});

test("a completion is judged by its body, which may carry an error under `200`", async () => {
  const sent = stubFetch(
    multipartProvider({
      complete: () =>
        xmlAnswer(
          "<Error><Code>InvalidPart</Code><Message>One or more of the specified parts could not be found.</Message></Error>",
          { "x-amz-request-id": "complete-request" },
        ),
    }),
  );
  const storage = s3Storage(options({ multipart: { partSize: smallestPart } }));

  const failure = await storageRejection(() =>
    storage.put("object.bin", streamOf(patternOf(smallestPart + 1), mebibyte)),
  );

  expect(failure.code).toBe("InvalidRequest");
  expect(failure.providerCode).toBe("InvalidPart");
  expect(failure.message).toBe("One or more of the specified parts could not be found.");
  expect(failure.requestId).toBe("complete-request");
  expect(sent.map(stepOf).filter((step) => step === "complete")).toHaveLength(1);
  expect(sent.map(stepOf).at(-1)).toBe("abort");
});

test("a completion that received no response is neither repeated nor aborted", async () => {
  immediateRetries();

  const sent = stubFetch(
    multipartProvider({
      complete: () => {
        throw new TypeError("fetch failed");
      },
    }),
  );
  const storage = s3Storage(options({ multipart: { partSize: smallestPart } }));

  const failure = await storageRejection(() =>
    storage.put("object.bin", streamOf(patternOf(smallestPart + 1), mebibyte)),
  );

  expect(failure.code).toBe("NetworkError");
  expect(failure.retryable).toBe(true);
  expect(failure.attempts).toBe(1);
  expect(sent.map(stepOf).filter((step) => step === "complete")).toHaveLength(1);
  expect(sent.map(stepOf)).not.toContain("abort");
});

test("a completion answered with a transient status is repeated on the budget", async () => {
  immediateRetries();

  let completions = 0;
  const provider = multipartProvider();
  const sent = stubFetch(
    multipartProvider({
      complete: async (request) => {
        completions += 1;

        if (completions === 1) return refused(503, "SlowDown", "Please reduce your request rate.");

        return await provider(request);
      },
    }),
  );
  const storage = s3Storage(options({ multipart: { partSize: smallestPart } }));

  const written = await storage.put("object.bin", streamOf(patternOf(smallestPart + 1), mebibyte));

  expect(written.etag).toBe("assembled-3");
  expect(sent.map(stepOf).filter((step) => step === "complete")).toHaveLength(2);
});

test("a start of the upload that received no response is repeated", async () => {
  immediateRetries();

  let creations = 0;
  const provider = multipartProvider();
  const sent = stubFetch(
    multipartProvider({
      create: async (request) => {
        creations += 1;

        if (creations === 1) throw new TypeError("fetch failed");

        return await provider(request);
      },
    }),
  );
  const storage = s3Storage(options({ multipart: { partSize: smallestPart } }));

  await storage.put("object.bin", streamOf(patternOf(smallestPart + 1), mebibyte));

  expect(sent.map(stepOf).filter((step) => step === "create")).toHaveLength(2);
});

test("a completion whose `200` broke before its body said how it went is not aborted", async () => {
  const sent = stubFetch(
    multipartProvider({
      complete: () =>
        new Response(
          new ReadableStream({
            pull(controller) {
              controller.error(new TypeError("terminated"));
            },
          }),
          { status: 200 },
        ),
    }),
  );
  const storage = s3Storage(options({ multipart: { partSize: smallestPart } }));

  const failure = await storageRejection(() =>
    storage.put("object.bin", streamOf(patternOf(smallestPart + 1), mebibyte)),
  );

  expect(failure.code).toBe("NetworkError");
  expect(failure.retryable).toBe(true);
  expect(sent.map(stepOf)).not.toContain("abort");
});
