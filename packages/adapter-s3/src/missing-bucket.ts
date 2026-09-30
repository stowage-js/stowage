import { isStorageError, type StorageError } from "@stowage/core";

import type { S3Configuration } from "./configuration.ts";
import { type S3Request, send } from "./request.ts";

export type HeadRequest = Pick<S3Request, "operation" | "signal"> & { readonly key: string };

/**
 * Spec 7.9: AWS answers a `HEAD` in a missing bucket with the `404` it answers for an absent
 * key, and a `HEAD` carries no body to tell the two apart. A `GET` of the same key's first
 * byte does, needing the `s3:GetObject` the `HEAD` needed. Only a missing bucket is an
 * answer: a success or a `416` means a writer created the object in between, and a
 * compatible endpoint may name no code at all, so either leaves the `HEAD`'s answer
 * standing (ADR 0043). A `GET` that received no response is no answer, and rejects the call
 * with its `NetworkError`, which `exists` rethrows rather than answering `false`.
 */
export async function probeMissingBucket(
  configuration: S3Configuration,
  request: HeadRequest,
): Promise<StorageError | undefined> {
  try {
    const response = await send(configuration, {
      ...request,
      method: "GET",
      headers: [["range", "bytes=0-0"]],
    });

    await response.body?.cancel();

    return undefined;
  } catch (failure) {
    // Spec 4.10: the caller's abort travels on as the runtime's `AbortError`.
    if (!isStorageError(failure)) throw failure;

    return isMissingBucket(failure) || failure.code === "NetworkError" ? failure : undefined;
  }
}

/** Spec 4.10: `NotFound` without `key` is a missing bucket, with it a missing object. */
export function isMissingBucket(failure: StorageError): boolean {
  return failure.code === "NotFound" && failure.key === undefined;
}
