import { isStorageError, type StorageError } from "@stowage/core";

import type { S3Configuration } from "./configuration.ts";
import { type S3Request, send } from "./request.ts";

export type HeadRequest = Pick<S3Request, "operation" | "signal"> & { readonly key: string };

const badRequest = 400;
const lastClientError = 499;
/** The answer to the first byte of an empty object, which exists. */
const rangeNotSatisfiable = 416;

/**
 * Spec 7.9: a `HEAD` is refused without a body, so the provider's code never arrives with
 * it, and AWS answers a missing bucket with the `404` it answers for an absent key. A `GET`
 * of the same key's first byte names the code, needing the `s3:GetObject` the `HEAD`
 * needed (ADR 0043, ADR 0066).
 */
export async function sendHead(
  configuration: S3Configuration,
  request: HeadRequest,
): Promise<Response> {
  const head: S3Request = { method: "HEAD", ...request };

  try {
    return await send(configuration, head);
  } catch (failure) {
    if (!isStorageError(failure) || !isReadByAGet(failure)) throw failure;

    const reading = await readRefusal(configuration, request);

    if (reading.kind === "refused") throw reading.failure;
    if (reading.kind === "standing") throw failure;

    // Spec 7.9: one `HEAD` more under the credential the `GET` refreshed, and none after
    // it, so a resolver that hands back the refused credential costs four requests at most.
    return await send(configuration, head);
  }
}

/**
 * A refusal whose condition the status leaves open. A transient one is the retry budget's,
 * and spec 7.9 already reads the `400` to a key above 1024 bytes as `InvalidKey`.
 */
function isReadByAGet(failure: StorageError): boolean {
  const status = failure.status ?? 0;

  if (failure.retryable || failure.code === "InvalidKey") return false;

  return status >= badRequest && status <= lastClientError;
}

/**
 * What the `GET` says of the refused `HEAD`: `refused` with the failure that names its
 * code, `refreshed` where it was answered under a credential refreshed after a refusal of
 * its own, and `standing` where it leaves the `HEAD`'s answer as it is.
 */
type Reading =
  | { readonly kind: "refused"; readonly failure: StorageError }
  | { readonly kind: "refreshed" }
  | { readonly kind: "standing" };

/**
 * A success or a `416` without a refresh means a writer created the object in between, and
 * a compatible endpoint may name no code at all, so either leaves the `HEAD`'s answer
 * standing. A `GET` that received no response is no answer: the call rejects with its
 * `NetworkError`, or with what the resolver threw for its refresh, which `exists` rethrows
 * rather than answering `false`.
 */
async function readRefusal(configuration: S3Configuration, request: HeadRequest): Promise<Reading> {
  let refreshed = false;
  const standing: Reading = { kind: "standing" };

  try {
    const response = await send(configuration, {
      ...request,
      method: "GET",
      headers: [["range", "bytes=0-0"]],
      onRefresh: () => {
        refreshed = true;
      },
    });

    try {
      await response.body?.cancel();
    } catch {
      // Cleanup cannot replace the HEAD's answer, but the caller's abort still travels on.
      request.signal?.throwIfAborted();
    }
  } catch (failure) {
    // Spec 4.10: the caller's abort travels on as the runtime's `AbortError`.
    if (!isStorageError(failure)) throw failure;

    if (failure.status !== rangeNotSatisfiable) {
      return failure.providerCode !== undefined || failure.status === undefined
        ? { kind: "refused", failure }
        : standing;
    }
  }

  return refreshed ? { kind: "refreshed" } : standing;
}
