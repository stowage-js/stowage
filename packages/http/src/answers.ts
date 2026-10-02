import { isStorageError, type StorageError } from "@stowage/core";

// Spec 10.2: an answer is recognised by the object itself, which a copy is not, and which
// still holds where a server replaces the global `Response` with a subclass, as
// `@hono/node-server` does, so that `instanceof` would compare the wrong constructor.
const errorsBehind = new WeakMap<Response, StorageError>();

/**
 * The `StorageError` the layer answered with this very `Response`. A `Response` the layer
 * built otherwise, one it did not build, and a copy of one answer `undefined`.
 */
export function storageErrorOf(response: Response): StorageError | undefined {
  return errorsBehind.get(response);
}

/**
 * Spec 10.2: a `StorageError` becomes a status by what it says about the request, with an
 * empty body, since a provider's message names buckets and accounts. Anything else is
 * thrown on, an `AbortError` and a programmer error among it.
 */
export function answerFor(thrown: unknown): Response {
  if (!isStorageError(thrown)) throw thrown;

  const response = new Response(null, { status: statusOf(thrown) });

  errorsBehind.set(response, thrown);

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
