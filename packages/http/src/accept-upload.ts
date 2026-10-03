import type { ObjectStat, Storage } from "@stowage/core";

import { answerFor, methodNotAllowed, refusal, storedAnswer } from "./answers.ts";

export interface AcceptUploadOptions {
  /**
   * The most bytes the body may hold: a non-negative integer, or `Infinity` for a route
   * that takes any size. It has no default, since an upload route without a limit is an
   * open bill, and only the layer can enforce one while the body streams (ADR 0049). A
   * `Content-Length` above it is `413` before the body is read, and a body passing it is
   * `413` before `put` sees its end. Any other value rejects with a `TypeError` whatever the
   * method, since it is the caller's mistake and not the client's.
   */
  maxSize: number;
  /** Replaces the request's `Content-Type`, which replaces the storage's default. */
  contentType?: string;
  /** The user metadata stored with the object. Request headers never add to it. */
  userMetadata?: Record<string, string>;
}

/**
 * Streams the body of a `PUT` into `put` and answers `201` with the `etag` as `ETag`
 * (spec 10.5). Any other method is `405`. A body above `maxSize` is `413`, one that
 * contradicts its `Content-Length` or fails while it is read `400`, a content coding `415`;
 * the key then holds what it held before. `objectStatOf(response)` answers what `put`
 * resolved with.
 */
export async function acceptUpload(
  storage: Storage,
  key: string,
  request: Request,
  options: AcceptUploadOptions,
): Promise<Response> {
  const { maxSize } = options;

  if (maxSize !== Number.POSITIVE_INFINITY && !(Number.isInteger(maxSize) && maxSize >= 0)) {
    throw new TypeError(`\`maxSize\` is ${String(maxSize)}, no non-negative integer or Infinity`);
  }

  if (request.method !== "PUT") return methodNotAllowed("PUT");

  // ADR 0052: a body a validator or a parser read before the call would be stored empty
  // or partial, and that is the caller's programmer error, not a client's.
  if (request.bodyUsed) {
    throw new TypeError("The request body was read before `acceptUpload` could store it");
  }

  // RFC 9110 8.4.1: no runtime decodes a request body, so the coded bytes would be stored
  // without their coding.
  if (!isIdentity(request.headers.get("content-encoding"))) return refusal(415);

  const announced = request.headers.get("content-length");

  if (announced !== null && !/^\d+$/u.test(announced)) return refusal(400);

  const contentLength = announced === null ? undefined : Number(announced);

  if (contentLength !== undefined && contentLength > maxSize) return refusal(413);

  const counted = countedBody(request.body ?? emptyBody(), { maxSize, contentLength });
  let stat: ObjectStat;

  try {
    stat = await storage.put(key, counted.body, {
      contentType: options.contentType ?? request.headers.get("content-type") ?? undefined,
      userMetadata: options.userMetadata,
      signal: request.signal,
    });
  } catch (thrown) {
    // An adapter rejects for the stream the layer errored as it pleases, a `NetworkError`
    // among the ways, and the client's mistake must not read as the provider's.
    const refused = counted.refused();

    return refused === undefined ? answerFor(thrown) : refusal(refused);
  }

  return storedAnswer(stat);
}

function isIdentity(contentEncoding: string | null): boolean {
  return (contentEncoding ?? "")
    .split(",")
    .map((coding) => coding.trim().toLowerCase())
    .every((coding) => coding === "" || coding === "identity");
}

function emptyBody(): ReadableStream<Uint8Array> {
  return new ReadableStream({ start: (controller) => controller.close() });
}

/** `413` for a body past `maxSize`, `400` for one that contradicts its length or failed. */
type BodyRefusal = 400 | 413;

interface Limits {
  readonly maxSize: number;
  readonly contentLength: number | undefined;
}

interface CountedBody {
  readonly body: ReadableStream<Uint8Array>;
  /** The status the layer refused the body with, once it did. */
  refused(): BodyRefusal | undefined;
}

/**
 * The body as `put` reads it, counted chunk by chunk. A body past `maxSize`, past or short
 * of its length, or failing while it is read, errors the stream before `put` sees its end,
 * so that `put` rejects and the key keeps what it held (flow 1).
 */
function countedBody(source: ReadableStream<Uint8Array>, limits: Limits): CountedBody {
  const reader = source.getReader();
  let count = 0;
  let refused: BodyRefusal | undefined;
  // Once `put` canceled the body, at an abort among others, the read pending on the source
  // ends early, and that end is no body short of its length.
  let canceled = false;

  const refuse = (
    controller: ReadableStreamDefaultController<Uint8Array>,
    status: BodyRefusal,
    reason: Error,
  ): void => {
    refused = status;
    controller.error(reason);
    // `put` cancels no stream that already failed, so the rest of the body is let go here.
    reader.cancel(reason).catch(() => {});
  };

  const body = new ReadableStream<Uint8Array>(
    {
      async pull(controller) {
        let chunk: ReadableStreamReadResult<Uint8Array>;

        try {
          chunk = await reader.read();
        } catch (failure) {
          if (canceled) return;

          refused = 400;
          controller.error(failure);
          return;
        }

        if (canceled) return;

        if (chunk.done) {
          if (limits.contentLength === undefined || count === limits.contentLength)
            controller.close();
          else refuse(controller, 400, new Error("The body ended short of its Content-Length"));
          return;
        }

        count += chunk.value.byteLength;

        // A body below `maxSize` with a `Content-Length` runs past that length no later
        // than past `maxSize`, so the length is told first.
        if (limits.contentLength !== undefined && count > limits.contentLength) {
          refuse(controller, 400, new Error("The body runs past its Content-Length"));
        } else if (count > limits.maxSize) {
          refuse(controller, 413, new Error("The body runs past maxSize"));
        } else {
          controller.enqueue(chunk.value);
        }
      },
      async cancel(reason) {
        canceled = true;
        await reader.cancel(reason);
      },
    },
    // No chunk is read ahead of `put`, so a refused body never sits in this stream's queue.
    { highWaterMark: 0 },
  );

  return { body, refused: () => refused };
}
