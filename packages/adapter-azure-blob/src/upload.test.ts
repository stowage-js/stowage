import { isStorageError, type StorageError } from "@stowage/core";
import { afterEach, expect, test, vi } from "vitest";

import { type AzureBlobAdapterOptions, azureBlobStorage } from "./index.ts";

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

const kibibyte = 1024;
const mebibyte = 1024 * kibibyte;

/** The smallest part spec 8.1 accepts, which keeps a block upload cheap to stub. */
const smallestPart = 5 * mebibyte;

interface SentRequest {
  readonly url: URL;
  readonly method: string;
  readonly headers: Headers;
  readonly body: Uint8Array | undefined;
  /** The size of the buffer behind the body, which is what the request holds in memory. */
  readonly heldBytes?: number;
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
      body: sentBytes(init.body),
      heldBytes: init.body instanceof Uint8Array ? init.body.buffer.byteLength : undefined,
      signal: init.signal ?? undefined,
    };

    sent.push(request);

    return await answer(request);
  });

  return sent;
}

/** Copied as `fetch` sends it, since a part's buffer goes on to hold a later part. */
function sentBytes(body: unknown): Uint8Array | undefined {
  return body instanceof Uint8Array ? body.slice() : undefined;
}

/** What Azure answers `Put Blob` and `Put Block List` with: the entity tag and the time. */
function created(): Response {
  return new Response(null, {
    status: 201,
    headers: { etag: '"0x8DCA1B2C3D4E5F6"', "last-modified": "Sun, 30 Aug 2026 12:36:00 GMT" },
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

const accessToken = "eyJ0eXAiOiJKV1QifQ.e30.";

function storage(overrides: Partial<AzureBlobAdapterOptions> = {}) {
  return azureBlobStorage({
    account: "stowage",
    container: "conformance",
    credentials: { accessToken },
    ...overrides,
  });
}

test("a stream that ends within one part goes as one `Put Blob`", async () => {
  const sent = stubFetch(created);
  const bytes = patternOf(64 * kibibyte);
  const body = streamOf(bytes, 4 * kibibyte);

  const written = await storage().put("object.bin", body, { contentType: "text/plain" });

  expect(sent).toHaveLength(1);
  expect(sent[0]?.method).toBe("PUT");
  expect(sent[0]?.url.search).toBe("");
  expect(sent[0]?.headers.get("x-ms-blob-type")).toBe("BlockBlob");
  expect(sent[0]?.headers.get("content-type")).toBe("text/plain");
  expect(firstDifference(sent[0]?.body, bytes)).toBe(-1);
  expect(written.size).toBe(bytes.byteLength);
  // Spec 4.2 leaves the stream at its end, with no reader holding it.
  expect(body.locked).toBe(false);
});

test("a stream that yields nothing goes as one empty `Put Blob`", async () => {
  const sent = stubFetch(created);

  const written = await storage().put("object.bin", streamOf(new Uint8Array(0), 1));

  expect(sent).toHaveLength(1);
  expect(sent[0]?.body?.byteLength).toBe(0);
  expect(written.size).toBe(0);
});

/** The request of a block upload a `SentRequest` is, read off its method and query. */
function stepOf(request: SentRequest): string {
  const comp = request.url.searchParams.get("comp");

  if (request.method === "PUT" && comp === "block") return `block ${partIndexOf(request)}`;
  if (request.method === "PUT" && comp === "blocklist") return "commit";

  return `${request.method} ${request.url.pathname}${request.url.search}`;
}

/** The twenty bytes a block id stands for. */
function blockIdBytes(blockId: string): Uint8Array {
  return Uint8Array.from(atob(blockId), (character) => character.charCodeAt(0));
}

/** The part index a `Put Block` carries in the last four bytes of its id, big-endian. */
function partIndexOf(request: SentRequest): number {
  const bytes = blockIdBytes(request.url.searchParams.get("blockid") ?? "");

  return new DataView(bytes.buffer).getUint32(16);
}

/** What Azure answers each request of a block upload with, where it accepts it. */
function blockProvider(overrides: Partial<Record<string, Answer>> = {}): Answer {
  return async (request) => {
    const step = stepOf(request);
    const override = overrides[step] ?? overrides[step.split(" ")[0] ?? ""];

    if (override !== undefined) return await override(request);

    if (step.startsWith("block ")) return new Response(null, { status: 201 });
    if (step === "commit") return created();

    throw new Error(`The stub answers no ${step}`);
  };
}

/** The `Put Block` requests of an upload, in part order. */
function blocksOf(sent: readonly SentRequest[]): SentRequest[] {
  return sent
    .filter((request) => stepOf(request).startsWith("block "))
    .toSorted((one, other) => partIndexOf(one) - partIndexOf(other));
}

/** The bytes the blocks of an upload carried, concatenated in part order. */
function assembled(sent: readonly SentRequest[]): Uint8Array {
  const blocks = blocksOf(sent);
  const bytes = new Uint8Array(
    blocks.reduce((size, block) => size + (block.body?.byteLength ?? 0), 0),
  );
  let offset = 0;

  for (const block of blocks) {
    bytes.set(block.body ?? new Uint8Array(0), offset);
    offset += block.body?.byteLength ?? 0;
  }

  return bytes;
}

test("a stream that fills more than one part is staged as blocks and committed once", async () => {
  const sent = stubFetch(blockProvider());
  const bytes = patternOf(2 * smallestPart + 3);
  const upload = storage({ multipart: { partSize: smallestPart } });

  const written = await upload.put("object.bin", streamOf(bytes, mebibyte), {
    contentType: "text/plain",
    userMetadata: { writtenBy: "stowage" },
  });

  // Blocks in flight together reach the provider in no promised order.
  const steps = sent.map(stepOf);

  expect(steps.toSorted()).toEqual(["block 0", "block 1", "block 2", "commit"]);
  expect(steps.at(-1)).toBe("commit");

  const blocks = blocksOf(sent);
  const commit = sent.at(-1);
  const blockIds = blocks.map((block) => block.url.searchParams.get("blockid") ?? "");

  expect(blocks.map((block) => block.body?.byteLength)).toEqual([smallestPart, smallestPart, 3]);
  expect(firstDifference(assembled(sent), bytes)).toBe(-1);
  // ADR 0024: sixteen random bytes drawn once per upload, then the part index.
  expect(blockIds.map((blockId) => blockIdBytes(blockId).byteLength)).toEqual([20, 20, 20]);
  expect(new Set(blockIds.map((blockId) => blockId.slice(0, 20))).size).toBe(1);
  expect(blocks.every((block) => block.headers.get("x-ms-blob-type") === null)).toBe(true);
  expect(new TextDecoder().decode(commit?.body)).toBe(
    `<?xml version="1.0" encoding="utf-8"?><BlockList>${blockIds.map((blockId) => `<Latest>${blockId}</Latest>`).join("")}</BlockList>`,
  );
  // A commit without them would reset the type and drop the metadata (ADR 0024).
  expect(commit?.headers.get("x-ms-blob-content-type")).toBe("text/plain");
  expect(commit?.headers.get("x-ms-meta-writtenby")).toBe("stowage");
  // Nothing about the upload reaches the API: the description is the object's alone.
  expect(written).toEqual({
    key: "object.bin",
    size: bytes.byteLength,
    lastModified: new Date("Sun, 30 Aug 2026 12:36:00 GMT"),
    etag: "0x8DCA1B2C3D4E5F6",
    contentType: "text/plain",
    userMetadata: { writtenby: "stowage" },
  });
});

test("every upload draws block ids of its own", async () => {
  const sent = stubFetch(blockProvider());
  const upload = storage({ multipart: { partSize: smallestPart } });

  await upload.put("object.bin", streamOf(patternOf(smallestPart + 1), mebibyte));
  await upload.put("object.bin", streamOf(patternOf(smallestPart + 1), mebibyte));

  const firstBlocks = blocksOf(sent.slice(0, 3));
  const secondBlocks = blocksOf(sent.slice(3));

  expect(firstBlocks[0]?.url.searchParams.get("blockid")).not.toBe(
    secondBlocks[0]?.url.searchParams.get("blockid"),
  );
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

/** What Azure answers a failed request with: the code in a header, and a document beside it. */
function refused(status: number, code: string, message: string): Response {
  return new Response(
    `﻿<?xml version="1.0" encoding="utf-8"?><Error><Code>${code}</Code><Message>${message}</Message></Error>`,
    {
      status,
      headers: {
        "content-type": "application/xml",
        "x-ms-error-code": code,
        "x-ms-request-id": "request-1",
      },
    },
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

/** Lets every timer and pending request run, so a request sent late would show in `sent`. */
async function settled(): Promise<void> {
  await new Promise((resolve) => {
    globalThis.setTimeout(resolve, 50);
  });
}

// ADR 0024: a repeat finds the blocks uncommitted, or committed by the first commit, and
// commits the same bytes in the same order; there is no ambiguous outcome as on S3.
test("a commit that received no response is sent again with the headers it carried", async () => {
  immediateRetries();

  let commits = 0;
  const sent = stubFetch(
    blockProvider({
      commit: () => {
        commits += 1;

        if (commits === 1) throw new TypeError("fetch failed");

        return created();
      },
    }),
  );
  const upload = storage({ multipart: { partSize: smallestPart } });

  const written = await upload.put("object.bin", streamOf(patternOf(smallestPart + 1), mebibyte), {
    contentType: "text/plain",
    userMetadata: { writtenBy: "stowage" },
  });

  const [first, second] = sent.filter((request) => stepOf(request) === "commit");

  expect(written.etag).toBe("0x8DCA1B2C3D4E5F6");
  expect(second).toBeDefined();
  expect(second?.headers.get("x-ms-blob-content-type")).toBe("text/plain");
  expect(second?.headers.get("x-ms-meta-writtenby")).toBe("stowage");
  expect(new TextDecoder().decode(second?.body)).toBe(new TextDecoder().decode(first?.body));
});

test("a commit answered with a transient status is repeated on the budget", async () => {
  immediateRetries();

  let commits = 0;
  const sent = stubFetch(
    blockProvider({
      commit: () => {
        commits += 1;

        return commits === 1
          ? refused(500, "OperationTimedOut", "The operation could not be completed.")
          : created();
      },
    }),
  );

  await storage({ multipart: { partSize: smallestPart } }).put(
    "object.bin",
    streamOf(patternOf(smallestPart + 1), mebibyte),
  );

  expect(sent.map(stepOf).filter((step) => step === "commit")).toHaveLength(2);
});

test("a block that fails is repeated with the same bytes", async () => {
  immediateRetries();

  let attempts = 0;
  const sent = stubFetch(
    blockProvider({
      "block 1": () => {
        attempts += 1;

        return attempts === 1
          ? refused(503, "ServerBusy", "The server is busy.")
          : new Response(null, { status: 201 });
      },
    }),
  );
  const bytes = patternOf(2 * smallestPart + 1);

  await storage({ multipart: { partSize: smallestPart } }).put(
    "object.bin",
    streamOf(bytes, mebibyte),
  );

  const secondBlocks = sent.filter((request) => stepOf(request) === "block 1");
  const secondPart = bytes.subarray(smallestPart, 2 * smallestPart);

  expect(secondBlocks).toHaveLength(2);
  expect(secondBlocks[0]?.url.searchParams.get("blockid")).toBe(
    secondBlocks[1]?.url.searchParams.get("blockid"),
  );
  expect(firstDifference(secondBlocks[0]?.body, secondPart)).toBe(-1);
  expect(firstDifference(secondBlocks[1]?.body, secondPart)).toBe(-1);
  expect(sent.map(stepOf).at(-1)).toBe("commit");
});

test("a block that spent its budget cancels the rest and the source, and rejects with its error", async () => {
  immediateRetries();

  const sent = stubFetch(
    blockProvider({
      "block 0": openUntilAborted,
      "block 1": () => refused(500, "InternalError", "Server encountered an internal error."),
    }),
  );
  const source = cancelableStream(10 * smallestPart);
  const upload = storage({ multipart: { partSize: smallestPart, concurrency: 2 } });

  const failure = await storageRejection(() => upload.put("object.bin", source.body));
  const sentWhenRejected = sent.length;

  await settled();

  expect(failure.code).toBe("ProviderError");
  expect(failure.status).toBe(500);
  expect(failure.message).toBe("Server encountered an internal error.");
  expect(failure.attempts).toBe(3);
  expect(sent.map(stepOf).filter((step) => step === "block 1")).toHaveLength(3);
  expect(sent.find((request) => stepOf(request) === "block 0")?.signal?.aborted).toBe(true);
  expect(source.canceled()).toBe(true);
  // Spec 8.6: nothing aborts a block upload, so nothing is sent once it stopped.
  expect(sent.map(stepOf).toSorted()).toEqual(["block 0", "block 1", "block 1", "block 1"]);
  expect(sent).toHaveLength(sentWhenRejected);
});

test("the caller's abort cancels the blocks in flight and rejects with `AbortError`", async () => {
  const controller = new AbortController();
  const sent = stubFetch(
    blockProvider({
      block: async (request) => {
        controller.abort();

        return await openUntilAborted(request);
      },
    }),
  );
  const source = cancelableStream(10 * smallestPart);
  const upload = storage({ multipart: { partSize: smallestPart } });

  const failure = await rejection(() =>
    upload.put("object.bin", source.body, { signal: controller.signal }),
  );
  const sentWhenRejected = sent.length;

  await settled();

  expect(isStorageError(failure)).toBe(false);
  expect(failure).toHaveProperty("name", "AbortError");
  expect(source.canceled()).toBe(true);
  expect(blocksOf(sent).every((block) => block.signal?.aborted)).toBe(true);
  expect(sent.every((request) => stepOf(request).startsWith("block "))).toBe(true);
  expect(sent).toHaveLength(sentWhenRejected);
});

test("the caller's abort during the commit rejects with `AbortError` and sends nothing after", async () => {
  const controller = new AbortController();
  const sent = stubFetch(
    blockProvider({
      commit: async (request) => {
        controller.abort();

        return await openUntilAborted(request);
      },
    }),
  );
  const upload = storage({ multipart: { partSize: smallestPart } });

  const failure = await rejection(() =>
    upload.put("object.bin", streamOf(patternOf(smallestPart + 1), mebibyte), {
      signal: controller.signal,
    }),
  );

  await settled();

  expect(failure).toHaveProperty("name", "AbortError");
  expect(sent.map(stepOf).toSorted()).toEqual(["block 0", "block 1", "commit"]);
});

interface HeldBlocks {
  readonly answer: Answer;
  /** The most `Put Block` requests that were in flight at once. */
  readonly mostInFlight: () => number;
  /** The bytes each `Put Block` found read out of the stream and not yet answered. */
  readonly heldAtEachBlock: number[];
}

/**
 * `Put Block` requests held open until `concurrency` of them are waiting, so an upload
 * that sends them one by one shows as a single request in flight rather than as a race. A
 * request that finds fewer beside it goes on after a moment, which is the last blocks.
 */
function heldBlocks(concurrency: number, pulled: () => number): HeldBlocks {
  let waiting: (() => void)[] = [];
  let inFlight = 0;
  let mostInFlight = 0;
  let answered = 0;
  const heldAtEachBlock: number[] = [];
  const provider = blockProvider();

  return {
    heldAtEachBlock,
    mostInFlight: () => mostInFlight,
    async answer(request) {
      if (!stepOf(request).startsWith("block ")) return await provider(request);

      inFlight += 1;
      mostInFlight = Math.max(mostInFlight, inFlight);
      heldAtEachBlock.push(pulled() - answered);

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

test("blocks go `concurrency` at a time, and the upload holds no more of the stream", async () => {
  let pulled = 0;
  const held = heldBlocks(2, () => pulled);
  const sent = stubFetch(held.answer);
  const bytes = patternOf(6 * smallestPart + 1);
  const upload = storage({ multipart: { partSize: smallestPart, concurrency: 2 } });

  await upload.put(
    "object.bin",
    streamOf(bytes, mebibyte, (total) => {
      pulled = total;
    }),
  );

  expect(firstDifference(assembled(sent), bytes)).toBe(-1);
  expect(held.mostInFlight()).toBe(2);
  // The blocks in flight, and the chunk read ahead to learn whether the stream goes on
  // together with the one the stream itself queues in front of the next read.
  expect(Math.max(...held.heldAtEachBlock)).toBeLessThanOrEqual(2 * smallestPart + 2 * mebibyte);
});

test("parts are 8 MiB and go four at a time by default", async () => {
  let pulled = 0;
  const held = heldBlocks(4, () => pulled);
  const sent = stubFetch(held.answer);
  const bytes = patternOf(5 * 8 * mebibyte + 1);

  await storage().put(
    "object.bin",
    streamOf(bytes, mebibyte, (total) => {
      pulled = total;
    }),
  );

  expect(blocksOf(sent).map((block) => block.body?.byteLength)).toEqual([
    ...Array.from({ length: 5 }, () => 8 * mebibyte),
    1,
  ]);
  expect(held.mostInFlight()).toBe(4);
  expect(Math.max(...held.heldAtEachBlock)).toBeLessThanOrEqual(4 * 8 * mebibyte + 2 * mebibyte);
});

test("a stream that needs more than 50,000 parts rejects naming `partSize` and the way past it", async () => {
  // The bodies are counted rather than kept: 50,000 parts would not fit in memory.
  const steps: string[] = [];
  const provider = blockProvider();

  vi.stubGlobal("fetch", async (url: string, init: RequestInit): Promise<Response> => {
    const request: SentRequest = {
      url: new URL(url),
      method: init.method ?? "GET",
      headers: new Headers(init.headers),
      body: undefined,
      signal: undefined,
    };

    steps.push(stepOf(request));

    return await provider(request);
  });

  const chunk = new Uint8Array(smallestPart);
  let canceled = false;
  const body = new ReadableStream<Uint8Array>({
    pull(controller) {
      controller.enqueue(chunk);
    },
    cancel() {
      canceled = true;
    },
  });
  const upload = storage({ multipart: { partSize: smallestPart } });

  const failure = await storageRejection(() => upload.put("object.bin", body));

  expect(failure.code).toBe("InvalidRequest");
  expect(failure.attempts).toBe(0);
  expect(failure.message).toContain("50000 parts");
  expect(failure.message).toContain(`\`partSize\` of ${smallestPart} bytes`);
  expect(failure.message).toContain("a larger `multipart.partSize`");
  // The part that would be the 50,000th is known not to be the last, so it is not sent.
  expect(steps.filter((step) => step.startsWith("block "))).toHaveLength(49_999);
  expect(steps).not.toContain("commit");
  expect(canceled).toBe(true);
}, 30_000);

// ADR 0024: the blocks the commit named are gone once another writer committed, so a
// repeat cannot help, and the adapter's requests are valid by construction.
test("`InvalidBlockList` on the commit is `ProviderError`, not repeated, and nothing follows", async () => {
  immediateRetries();

  const sent = stubFetch(
    blockProvider({
      commit: () => refused(400, "InvalidBlockList", "The specified block list is invalid."),
    }),
  );

  const failure = await storageRejection(() =>
    storage({ multipart: { partSize: smallestPart } }).put(
      "object.bin",
      streamOf(patternOf(smallestPart + 1), mebibyte),
    ),
  );

  await settled();

  expect(failure.code).toBe("ProviderError");
  expect(failure.providerCode).toBe("InvalidBlockList");
  expect(failure.retryable).toBe(false);
  expect(failure.attempts).toBe(1);
  expect(sent.map(stepOf).toSorted()).toEqual(["block 0", "block 1", "commit"]);
});

test("`InvalidBlobOrBlock` on a block is `ProviderError` and not repeated", async () => {
  immediateRetries();

  const sent = stubFetch(
    blockProvider({
      "block 1": () =>
        refused(400, "InvalidBlobOrBlock", "The specified blob or block content is invalid."),
    }),
  );

  const failure = await storageRejection(() =>
    storage({ multipart: { partSize: smallestPart } }).put(
      "object.bin",
      streamOf(patternOf(smallestPart + 1), mebibyte),
    ),
  );

  expect(failure.code).toBe("ProviderError");
  expect(failure.providerCode).toBe("InvalidBlobOrBlock");
  expect(failure.retryable).toBe(false);
  expect(sent.map(stepOf).filter((step) => step === "block 1")).toHaveLength(1);
  expect(sent.map(stepOf)).not.toContain("commit");
});

test("`409 BlockCountExceedsLimit` on a block is `InvalidRequest`", async () => {
  const sent = stubFetch(
    blockProvider({
      block: () =>
        refused(
          409,
          "BlockCountExceedsLimit",
          "The uncommitted block count cannot exceed the maximum limit of 100,000 blocks.",
        ),
    }),
  );

  const failure = await storageRejection(() =>
    storage({ multipart: { partSize: smallestPart } }).put(
      "object.bin",
      streamOf(patternOf(smallestPart + 1), mebibyte),
    ),
  );

  expect(failure.code).toBe("InvalidRequest");
  expect(failure.providerCode).toBe("BlockCountExceedsLimit");
  expect(sent.map(stepOf)).not.toContain("commit");
});

test("held bytes above one part go as one `Put Blob`, which the adapter never splits", async () => {
  const sent = stubFetch(created);
  const bytes = patternOf(2 * smallestPart);
  const upload = storage({ multipart: { partSize: smallestPart } });

  await upload.put("object.bin", bytes);
  await upload.put("object.txt", "x".repeat(2 * smallestPart));

  expect(sent.map(stepOf)).toEqual(["PUT /conformance/object.bin", "PUT /conformance/object.txt"]);
  expect(firstDifference(sent[0]?.body, bytes)).toBe(-1);
  expect(sent[1]?.body?.byteLength).toBe(2 * smallestPart);
});

test("held bytes Azure finds too large are `InvalidRequest`, sent once", async () => {
  const sent = stubFetch(() =>
    refused(
      413,
      "RequestBodyTooLarge",
      "The request body is too large and exceeds the maximum permissible limit.",
    ),
  );

  const failure = await storageRejection(() => storage().put("object.bin", patternOf(kibibyte)));

  expect(failure.code).toBe("InvalidRequest");
  expect(failure.providerCode).toBe("RequestBodyTooLarge");
  expect(sent).toHaveLength(1);
});

/** A stream that yields `size` bytes and then neither ends nor yields again. */
function stallingStream(size: number): {
  body: ReadableStream<Uint8Array>;
  canceled: () => boolean;
} {
  let canceled = false;
  const bytes = patternOf(size);
  let pulled = 0;

  return {
    canceled: () => canceled,
    body: new ReadableStream({
      async pull(controller) {
        if (pulled >= bytes.byteLength) {
          await new Promise(() => {});
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

test("a block that fails while the stream stalls does not wait for the stream", async () => {
  const sent = stubFetch(
    blockProvider({
      block: () =>
        refused(403, "AuthorizationPermissionMismatch", "This request is not authorized."),
    }),
  );
  const source = stallingStream(smallestPart + mebibyte);

  const failure = await storageRejection(() =>
    storage({ multipart: { partSize: smallestPart } }).put("object.bin", source.body),
  );

  expect(failure.code).toBe("AccessDenied");
  expect(source.canceled()).toBe(true);
  expect(sent.map(stepOf)).toEqual(["block 0"]);
});

test("the caller's abort while the stream stalls rejects with `AbortError`", async () => {
  const controller = new AbortController();
  const sent = stubFetch(blockProvider());
  const source = stallingStream(smallestPart + mebibyte);

  const put = rejection(() =>
    storage({ multipart: { partSize: smallestPart } }).put("object.bin", source.body, {
      signal: controller.signal,
    }),
  );

  await vi.waitFor(() => {
    expect(sent.map(stepOf)).toContain("block 0");
  });
  controller.abort();

  expect(await put).toHaveProperty("name", "AbortError");
  expect(source.canceled()).toBe(true);
  expect(sent.map(stepOf)).toEqual(["block 0"]);
});

test("a stream `put` refuses before any request is canceled", async () => {
  const sent = stubFetch(created);
  const source = cancelableStream(smallestPart);

  const failure = await storageRejection(() => storage().put("../outside", source.body));

  expect(failure.code).toBe("InvalidKey");
  expect(sent).toHaveLength(0);
  expect(source.canceled()).toBe(true);
});

test("a stream shorter than a part holds little more than its own size", async () => {
  const sent = stubFetch(created);
  const bytes = patternOf(100 * kibibyte);

  await storage().put("object.bin", streamOf(bytes, 4 * kibibyte));

  expect(firstDifference(sent[0]?.body, bytes)).toBe(-1);
  expect(sent[0]?.heldBytes).toBeLessThanOrEqual(2 * bytes.byteLength);
});
