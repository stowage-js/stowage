import { isStorageError, type StorageError } from "@stowage/core";
import { afterEach, expect, test, vi } from "vitest";

import { type GcsAdapterOptions, type GcsCredentials, gcsStorage } from "./index.ts";

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

const kibibyte = 1024;
const partSize = 256 * kibibyte;

const accessToken = "ya29.a0AfB_byC";
const uploadId = "ADPycdtSessionSecret0123456789";
const sessionUri = `https://storage.googleapis.com/upload/storage/v1/b/conformance/o?uploadType=resumable&upload_id=${uploadId}`;
const updated = "2026-09-29T07:12:03.456Z";

interface SentRequest {
  readonly url: string;
  readonly method: string;
  readonly headers: Headers;
  readonly bytes: Uint8Array;
  readonly signal: AbortSignal | null | undefined;
}

type Answer = (request: SentRequest, service: ServiceAnswer) => Response | Promise<Response>;

/** The service's own answer to the request, which keeps no more than `keep` bytes of a chunk. */
type ServiceAnswer = (options?: { readonly keep?: number }) => Response;

/**
 * A resumable session as the spike measured the service (ADR 0036): persisted bytes sent again
 * are ignored, a chunk past the persisted end is refused, a chunk naming the total commits, a
 * repeated commit answers the same object, and a `DELETE` answers `499` while the session is
 * open and the object once it committed.
 *
 * `instead` answers the request of that number, counted from 0, in place of the service, and
 * may hand the request to the service on its way.
 */
function stubSession(instead: Readonly<Record<number, Answer>> = {}) {
  const sent: SentRequest[] = [];
  let persisted = new Uint8Array(0);
  let committed: number | undefined;

  const service = (request: SentRequest, keep = Infinity): Response => {
    if (request.method === "POST") {
      return new Response(null, { status: 200, headers: { location: sessionUri } });
    }

    if (request.method === "DELETE") {
      return committed === undefined ? clientClosed() : committedObject(committed);
    }

    if (committed !== undefined) return committedObject(committed);

    const [, first, , total] =
      /^bytes (?:(\d+)-(\d+)|\*)\/(\d+|\*)$/u.exec(request.headers.get("content-range") ?? "") ??
      [];

    if (first !== undefined) {
      const offset = Number(first);

      if (offset > persisted.length) return new Response("gap", { status: 503 });

      const kept = request.bytes.subarray(persisted.length - offset, keep);
      const grown = new Uint8Array(persisted.length + kept.length);

      grown.set(persisted);
      grown.set(kept, persisted.length);
      persisted = grown;
    }

    if (total !== "*" && Number(total) === persisted.length) {
      committed = persisted.length;

      return committedObject(committed);
    }

    return resumeIncomplete(persisted.length);
  };

  vi.stubGlobal("fetch", async (url: string, init: RequestInit): Promise<Response> => {
    const request: SentRequest = {
      url,
      method: init.method ?? "GET",
      headers: new Headers(init.headers),
      bytes: new Uint8Array(await new Response(init.body).arrayBuffer()),
      signal: init.signal,
    };
    const answer = instead[sent.length];

    sent.push(request);
    init.signal?.throwIfAborted();

    if (answer === undefined) return service(request);

    return await answer(request, (options) => service(request, options?.keep));
  });

  return { sent, persisted: () => persisted };
}

function resumeIncomplete(persisted: number): Response {
  return new Response(null, {
    status: 308,
    headers: {
      "x-guploader-uploadid": uploadId,
      ...(persisted === 0 ? {} : { range: `bytes=0-${persisted - 1}` }),
    },
  });
}

function committedObject(size: number): Response {
  return Response.json(
    {
      kind: "storage#object",
      name: "object.bin",
      bucket: "conformance",
      generation: "1790665923456000",
      contentType: "application/x-stowage",
      size: String(size),
      etag: "CIDw3uCR2YgDEAE=",
      metadata: { origin: "stream" },
      updated,
    },
    { headers: { "x-guploader-uploadid": uploadId } },
  );
}

function clientClosed(): Response {
  return Response.json(
    {
      error: {
        code: 499,
        message: "Client Closed Request",
        errors: [{ message: "Client Closed Request", reason: "clientClosedRequest" }],
      },
    },
    { status: 499, headers: { "x-guploader-uploadid": uploadId } },
  );
}

/** Deterministic bytes, so that a byte in the wrong place shows. */
function pattern(size: number): Uint8Array {
  const bytes = new Uint8Array(size);

  for (let index = 0; index < size; index += 1) bytes[index] = (index * 31 + 7) & 0xff;

  return bytes;
}

// Rather than `toEqual`, which compares a part of 256 KiB element by element in seconds.
function sameBytes(one: Uint8Array | undefined, other: Uint8Array | undefined): boolean {
  if (one === undefined || other === undefined || one.byteLength !== other.byteLength) return false;

  return one.every((byte, index) => byte === other[index]);
}

/** The bytes in chunks of 64 KiB, as a stream a caller would pass. */
function streamOf(bytes: Uint8Array): {
  body: ReadableStream<Uint8Array>;
  canceled: () => unknown;
} {
  const chunkSize = 64 * kibibyte;
  let offset = 0;
  let canceled: unknown;

  return {
    canceled: () => canceled,
    body: new ReadableStream(
      {
        pull(controller) {
          if (offset >= bytes.byteLength) {
            controller.close();

            return;
          }

          controller.enqueue(bytes.slice(offset, offset + chunkSize));
          offset += chunkSize;
        },
        cancel(reason) {
          canceled = reason ?? "canceled";
        },
      },
      { highWaterMark: 0 },
    ),
  };
}

function storage(overrides: Partial<GcsAdapterOptions> = {}) {
  return gcsStorage({
    bucket: "conformance",
    credentials: { accessToken },
    multipart: { partSize },
    ...overrides,
  });
}

async function failureOf(operation: () => Promise<unknown>): Promise<StorageError> {
  const failure = await operation().then(
    () => undefined,
    (reason: unknown) => reason,
  );

  if (isStorageError(failure)) return failure;

  throw new Error(`The operation did not fail with a StorageError: ${String(failure)}`);
}

function contentRanges(sent: readonly SentRequest[]): (string | null)[] {
  return sent
    .filter(({ method }) => method === "PUT")
    .map(({ headers }) => headers.get("content-range"));
}

test("a stream above one part goes as one session: a start, the parts at their offsets, the last committing", async () => {
  const bytes = pattern(2 * partSize + 1000);
  const { sent, persisted } = stubSession();

  const stat = await storage().put("object.bin", streamOf(bytes).body, {
    contentType: "application/x-stowage",
    userMetadata: { Origin: "stream" },
  });

  const [start] = sent;

  expect(start?.method).toBe("POST");
  expect(start?.url).toBe(
    "https://storage.googleapis.com/upload/storage/v1/b/conformance/o?uploadType=resumable",
  );
  expect(start?.headers.get("authorization")).toBe(`Bearer ${accessToken}`);
  expect(JSON.parse(new TextDecoder().decode(start?.bytes))).toEqual({
    name: "object.bin",
    contentType: "application/x-stowage",
    metadata: { origin: "stream" },
  });
  expect(sent.slice(1).map(({ method, url }) => [method, url])).toEqual([
    ["PUT", sessionUri],
    ["PUT", sessionUri],
    ["PUT", sessionUri],
  ]);
  expect(contentRanges(sent)).toEqual([
    `bytes 0-${partSize - 1}/*`,
    `bytes ${partSize}-${2 * partSize - 1}/*`,
    `bytes ${2 * partSize}-${2 * partSize + 999}/${2 * partSize + 1000}`,
  ]);
  expect(sameBytes(persisted(), bytes)).toBe(true);
  expect(stat).toMatchObject({
    key: "object.bin",
    size: 2 * partSize + 1000,
    contentType: "application/x-stowage",
    userMetadata: { origin: "stream" },
  });
});

/** A chunk the service persisted whose answer never arrived. */
const lostAfterPersisting: Answer = (_, service) => {
  service();

  throw new TypeError("fetch failed");
};

const unanswered: Answer = () => {
  throw new TypeError("fetch failed");
};

/** A request the service never answers, which only its signal settles. */
const hanging: Answer = async (request) =>
  await new Promise<Response>((_, reject) => {
    request.signal?.addEventListener("abort", () => {
      reject(request.signal?.reason);
    });
  });

const unavailable: Answer = () => new Response("backend error", { status: 503 });

function withoutBackoff(): void {
  vi.spyOn(Math, "random").mockReturnValue(0);
}

test("where the last part is full, an empty request naming the total commits after it", async () => {
  const bytes = pattern(2 * partSize);
  const { sent, persisted } = stubSession();

  const stat = await storage().put("object.bin", streamOf(bytes).body);

  expect(contentRanges(sent)).toEqual([
    `bytes 0-${partSize - 1}/*`,
    `bytes ${partSize}-${2 * partSize - 1}/*`,
    `bytes */${2 * partSize}`,
  ]);
  expect(sent.at(-1)?.bytes.byteLength).toBe(0);
  expect(sameBytes(persisted(), bytes)).toBe(true);
  expect(stat.size).toBe(2 * partSize);
});

test("a stream that ends within the first part goes as the one multipart request", async () => {
  const { sent } = stubSession({ 0: () => committedObject(partSize) });

  await storage().put("object.bin", streamOf(pattern(partSize)).body);

  expect(sent).toHaveLength(1);
  expect(sent[0]?.url).toContain("uploadType=multipart");
});

test("`partSize` is 8 MiB where the options name none", async () => {
  const { sent } = stubSession();

  await storage({ multipart: undefined }).put(
    "object.bin",
    streamOf(pattern(8 * 1024 * kibibyte + 1)).body,
  );

  expect(contentRanges(sent)).toEqual([
    `bytes 0-${8 * 1024 * kibibyte - 1}/*`,
    `bytes ${8 * 1024 * kibibyte}-${8 * 1024 * kibibyte}/${8 * 1024 * kibibyte + 1}`,
  ]);
});

test("the chunks, the commit and the cancel carry no credential, so the resolver is called once", async () => {
  withoutBackoff();
  const resolver = vi.fn<() => GcsCredentials>(() => ({ accessToken }));
  const { sent } = stubSession({ 3: lostAfterPersisting, 4: unanswered, 5: unanswered });

  await storage({ credentials: resolver }).put("object.bin", streamOf(pattern(2 * partSize)).body);

  expect(resolver).toHaveBeenCalledTimes(1);
  expect(sent.slice(1).map(({ headers }) => headers.get("authorization"))).toEqual([
    null,
    null,
    null,
    null,
    null,
    null,
  ]);
  expect(sent.at(-1)?.method).toBe("DELETE");
});

test("a chunk whose answer was lost is sent again whole, as it was sent", async () => {
  withoutBackoff();
  const bytes = pattern(2 * partSize + 10);
  const { sent, persisted } = stubSession({ 1: lostAfterPersisting });

  await storage().put("object.bin", streamOf(bytes).body);

  expect(contentRanges(sent).slice(0, 2)).toEqual([
    `bytes 0-${partSize - 1}/*`,
    `bytes 0-${partSize - 1}/*`,
  ]);
  expect(sameBytes(sent[2]?.bytes, sent[1]?.bytes)).toBe(true);
  expect(sameBytes(persisted(), bytes)).toBe(true);
});

test("a short acknowledgement is answered with the rest of the part, spending no attempt", async () => {
  const bytes = pattern(2 * partSize + 10);
  const { sent, persisted } = stubSession({
    1: (_, service) => service({ keep: 100 * kibibyte }),
    2: (_, service) => service({ keep: 50 * kibibyte }),
  });

  await storage({ retry: false }).put("object.bin", streamOf(bytes).body);

  expect(contentRanges(sent).slice(0, 4)).toEqual([
    `bytes 0-${partSize - 1}/*`,
    `bytes ${100 * kibibyte}-${partSize - 1}/*`,
    `bytes ${150 * kibibyte}-${partSize - 1}/*`,
    `bytes ${partSize}-${2 * partSize - 1}/*`,
  ]);
  expect(sameBytes(persisted(), bytes)).toBe(true);
});

test("a `308` that acknowledges nothing new spends an attempt, and the budget spent cancels the session", async () => {
  withoutBackoff();
  const source = streamOf(pattern(3 * partSize));
  const { sent } = stubSession({
    2: (_, service) => service({ keep: 0 }),
    3: (_, service) => service({ keep: 0 }),
  });

  const failure = await failureOf(
    async () => await storage({ retry: { maxAttempts: 2 } }).put("object.bin", source.body),
  );

  expect(failure).toMatchObject({
    code: "ProviderError",
    status: 308,
    attempts: 2,
    retryable: true,
    requestId: undefined,
  });
  expect(contentRanges(sent)).toEqual([
    `bytes 0-${partSize - 1}/*`,
    `bytes ${partSize}-${2 * partSize - 1}/*`,
    `bytes ${partSize}-${2 * partSize - 1}/*`,
  ]);
  expect(sent.at(-1)?.method).toBe("DELETE");
  expect(source.canceled()).toBe(failure);
});

test.each([
  ["ends before the part's first byte", "bytes=0-99"],
  ["ends beyond what was sent", `bytes=0-${2 * partSize}`],
  ["is no range of the object's start", `bytes=10-${2 * partSize - 1}`],
])("a range that %s is a `ProviderError`, not repeated", async (_, range) => {
  const { sent } = stubSession({
    2: () => new Response(null, { status: 308, headers: { range } }),
  });

  const failure = await failureOf(
    async () => await storage().put("object.bin", streamOf(pattern(3 * partSize)).body),
  );

  expect(failure).toMatchObject({ code: "ProviderError", status: 308, attempts: 1 });
  expect(failure.retryable).not.toBe(true);
  expect(sent.map(({ method }) => method)).toEqual(["POST", "PUT", "PUT", "DELETE"]);
});

test("a commit whose answer was lost is sent again, and its object resolves `put`", async () => {
  withoutBackoff();
  const { sent } = stubSession({ 2: lostAfterPersisting });

  const stat = await storage().put("object.bin", streamOf(pattern(partSize + 10)).body);

  expect(contentRanges(sent)).toEqual([
    `bytes 0-${partSize - 1}/*`,
    `bytes ${partSize}-${partSize + 9}/${partSize + 10}`,
    `bytes ${partSize}-${partSize + 9}/${partSize + 10}`,
  ]);
  expect(stat.size).toBe(partSize + 10);
});

test("a commit that spent its budget unanswered is settled by the cancel, meeting a committed session", async () => {
  withoutBackoff();
  const { sent } = stubSession({ 2: lostAfterPersisting, 3: unanswered, 4: unanswered });

  const stat = await storage().put("object.bin", streamOf(pattern(partSize + 10)).body);

  expect(sent.map(({ method }) => method)).toEqual(["POST", "PUT", "PUT", "PUT", "PUT", "DELETE"]);
  expect(stat).toMatchObject({ key: "object.bin", size: partSize + 10 });
});

test("the cancel after an unanswered commit meeting an open session rejects with the commit's `NetworkError`", async () => {
  withoutBackoff();
  const { sent } = stubSession({ 2: unanswered, 3: unanswered, 4: unanswered });

  const failure = await failureOf(
    async () => await storage().put("object.bin", streamOf(pattern(partSize + 10)).body),
  );

  expect(failure).toMatchObject({ code: "NetworkError", attempts: 3, retryable: true });
  expect(sent.map(({ method }) => method)).toEqual(["POST", "PUT", "PUT", "PUT", "PUT", "DELETE"]);
});

test("a cancel that fails after an unanswered commit leaves `put` rejecting with the commit's failure", async () => {
  const { sent } = stubSession({ 2: unanswered, 3: unanswered });

  const failure = await failureOf(
    async () =>
      await storage({ retry: false }).put("object.bin", streamOf(pattern(partSize + 10)).body),
  );

  expect(failure).toMatchObject({ code: "NetworkError", attempts: 1 });
  expect(failure.message).not.toContain("DELETE");
  expect(sent.at(-1)?.method).toBe("DELETE");
});

test("a cancel that never answers times out after 10 seconds, leaving the commit's failure", async () => {
  vi.useFakeTimers();
  stubSession({ 2: unanswered, 3: hanging });

  let settled = false;
  const failure = failureOf(
    async () =>
      await storage({ retry: false }).put("object.bin", streamOf(pattern(partSize + 10)).body),
  ).finally(() => {
    settled = true;
  });

  await vi.advanceTimersByTimeAsync(9_999);

  expect(settled).toBe(false);

  await vi.advanceTimersByTimeAsync(1);

  expect(await failure).toMatchObject({ code: "NetworkError", attempts: 1 });
});

test("a part that spent its budget cancels the source and the session, and rejects with its failure", async () => {
  withoutBackoff();
  const source = streamOf(pattern(3 * partSize));
  const { sent } = stubSession({ 2: unavailable, 3: unavailable, 4: unavailable, 5: unanswered });

  const failure = await failureOf(async () => await storage().put("object.bin", source.body));

  expect(failure).toMatchObject({ code: "ProviderError", status: 503, attempts: 3 });
  expect(failure.message).toBe("backend error");
  expect(source.canceled()).toBe(failure);
  // The unanswered cancel is repeated, and the `499` of the open session ends it unreported.
  expect(sent.map(({ method }) => method)).toEqual([
    "POST",
    "PUT",
    "PUT",
    "PUT",
    "PUT",
    "DELETE",
    "DELETE",
  ]);
});

test("the caller's abort cancels the source and the session, and rejects with `AbortError`", async () => {
  const controller = new AbortController();
  const source = streamOf(pattern(3 * partSize));
  const { sent } = stubSession({
    2: (request) => {
      controller.abort();
      request.signal?.throwIfAborted();

      throw new Error("The part's signal did not follow the caller's");
    },
  });

  const failure = await storage()
    .put("object.bin", source.body, { signal: controller.signal })
    .catch((reason: unknown) => reason);

  expect(failure).toMatchObject({ name: "AbortError" });
  expect(source.canceled()).toBe(failure);

  const cancel = sent.at(-1);

  expect(cancel?.method).toBe("DELETE");
  expect(cancel?.url).toBe(sessionUri);
  expect(cancel?.signal?.aborted).toBe(false);
});

test("an abort while the commit is out rejects with `AbortError` even where the session committed", async () => {
  const controller = new AbortController();
  const { sent } = stubSession({
    2: (request, service) => {
      service();
      controller.abort();
      request.signal?.throwIfAborted();

      throw new Error("The commit's signal did not follow the caller's");
    },
  });

  const failure = await storage()
    .put("object.bin", streamOf(pattern(partSize + 10)).body, { signal: controller.signal })
    .catch((reason: unknown) => reason);

  expect(failure).toMatchObject({ name: "AbortError" });
  expect(sent.at(-1)?.method).toBe("DELETE");
});

test("no error names the session URI or its upload id, and none carries a `requestId`", async () => {
  const failures: StorageError[] = [];

  stubSession({
    1: () => {
      throw new TypeError(`error sending request for url (${sessionUri})`);
    },
    2: unanswered,
  });
  failures.push(
    await failureOf(
      async () =>
        await storage({ retry: false }).put("object.bin", streamOf(pattern(2 * partSize)).body),
    ),
  );

  stubSession({
    1: () =>
      Response.json(
        {
          error: {
            code: 400,
            message: `Invalid upload ${uploadId}`,
            errors: [{ reason: "invalid" }],
          },
        },
        { status: 400, headers: { "x-guploader-uploadid": uploadId } },
      ),
    2: unanswered,
  });
  failures.push(
    await failureOf(
      async () => await storage().put("object.bin", streamOf(pattern(2 * partSize)).body),
    ),
  );

  stubSession({
    0: () =>
      new Response("backend error", { status: 400, headers: { "x-guploader-uploadid": uploadId } }),
  });
  failures.push(
    await failureOf(
      async () => await storage().put("object.bin", streamOf(pattern(2 * partSize)).body),
    ),
  );

  for (const failure of failures) {
    expect(failure.message).not.toContain(uploadId);
    expect(failure.cause).toBeUndefined();
    expect(failure.requestId).toBeUndefined();
    expect(JSON.stringify(failure)).not.toContain(uploadId);
  }

  expect(failures[0]?.message).toContain("<session URI>");
});

test("a `404` from the session URI is a `ProviderError`: the session and its bytes are gone", async () => {
  stubSession({
    1: () =>
      Response.json(
        { error: { code: 404, message: "Not Found", errors: [{ reason: "notFound" }] } },
        { status: 404 },
      ),
  });

  const failure = await failureOf(
    async () => await storage().put("object.bin", streamOf(pattern(2 * partSize)).body),
  );

  expect(failure).toMatchObject({ code: "ProviderError", status: 404, key: "object.bin" });
  expect(failure.message).toContain("session is gone");
});

test("a start answered without a session URI is a `ProviderError`, and no chunk goes out", async () => {
  const { sent } = stubSession({ 0: () => new Response(null, { status: 200 }) });

  const failure = await failureOf(
    async () => await storage().put("object.bin", streamOf(pattern(2 * partSize)).body),
  );

  expect(failure).toMatchObject({ code: "ProviderError", status: 200 });
  expect(failure.message).toContain("no session URI");
  expect(sent).toHaveLength(1);
});
