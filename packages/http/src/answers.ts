import { isStorageError, type ObjectStat, type StorageError } from "@stowage/core";

// Spec 10.2: an answer is recognised by the object itself, which a copy is not, and which
// still holds where a server replaces the global `Response` with a subclass, as
// `@hono/node-server` does, so that `instanceof` would compare the wrong constructor.
const errorsBehind = new WeakMap<Response, StorageError>();
const statsBehind = new WeakMap<Response, ObjectStat>();

/**
 * The `StorageError` the layer answered with this very `Response`. A `Response` the layer
 * built otherwise, one it did not build, and a copy of one answer `undefined`.
 */
export function storageErrorOf(response: Response): StorageError | undefined {
  return errorsBehind.get(response);
}

/**
 * The `ObjectStat` `put` resolved with behind this very `Response` of `acceptUpload`. Any
 * other `Response` and a copy of one answer `undefined`.
 */
export function objectStatOf(response: Response): ObjectStat | undefined {
  return statsBehind.get(response);
}

/**
 * Spec 10.5's `201` for a stored object. The body stays empty, since the `key` and the
 * `userMetadata` of the `ObjectStat` may say more than the client should learn.
 */
export function storedAnswer(stat: ObjectStat): Response {
  const response = new Response(null, { status: 201 });

  if (stat.etag !== undefined) response.headers.set("etag", `"${stat.etag}"`);

  statsBehind.set(response, stat);

  return response;
}

/**
 * Spec 10.2: a `StorageError` becomes a status by what it says about the request, with an
 * empty body, since a provider's message names buckets and accounts. Anything else is
 * thrown on, an `AbortError` and a programmer error among it.
 */
export function answerFor(thrown: unknown): Response {
  if (!isStorageError(thrown)) throw thrown;

  return answerWith(thrown, statusOf(thrown));
}

/**
 * Spec 10.3's `416`, naming the size of the object. Built from the `InvalidRequest` of a
 * ranged `get` where one refused the range, and from none where the layer refused it.
 */
export function rangeNotSatisfiable(size: number, error?: StorageError): Response {
  const headers = { "content-range": `bytes */${size}` };

  return error === undefined
    ? new Response(null, { status: 416, headers })
    : answerWith(error, 416, headers);
}

function answerWith(error: StorageError, status: number, headers?: HeadersInit): Response {
  const response = new Response(null, { status, headers });

  errorsBehind.set(response, error);

  return response;
}

function statusOf(error: StorageError): number {
  switch (error.code) {
    // ADR 0043: a missing bucket is `NotFound` without a key, a misconfiguration of the
    // server rather than an absent object.
    case "NotFound":
      return error.key === undefined ? 500 : 404;
    case "InvalidKey":
      return 404;
    case "NetworkError":
      return 503;
    case "ProviderError":
      return error.retryable ? 503 : 500;
    default:
      return 500;
  }
}

export function methodNotAllowed(allow: string): Response {
  return new Response(null, { status: 405, headers: { allow } });
}

/** A refusal of the layer's own, which carries no `StorageError` and no body (spec 10.2). */
export function refusal(status: number): Response {
  return new Response(null, { status });
}
