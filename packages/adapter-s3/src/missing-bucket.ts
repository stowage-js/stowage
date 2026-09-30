import { isStorageError, type StorageError } from "@stowage/core";

import type { S3Configuration } from "./configuration.ts";
import { send } from "./request.ts";

export interface HeadRequest {
  readonly operation: string;
  readonly key: string;
  readonly signal?: AbortSignal;
}

/**
 * Spec 7.9: AWS answers a `HEAD` in a missing bucket with the `404` it answers for an absent
 * key, and a `HEAD` carries no body to tell the two apart. A `GET` of the same key's first
 * byte does, needing the `s3:GetObject` the `HEAD` needed. Only `NoSuchBucket` is an answer:
 * a success or a `416` means a writer created the object in between, and a compatible
 * endpoint may name no code at all, so either leaves the `HEAD`'s answer standing (ADR 0043).
 */
export async function missingBucketBehind(
  configuration: S3Configuration,
  request: HeadRequest,
): Promise<StorageError | undefined> {
  try {
    const response = await send(configuration, {
      method: "GET",
      operation: request.operation,
      key: request.key,
      headers: [["range", "bytes=0-0"]],
      signal: request.signal,
    });

    await response.body?.cancel();

    return undefined;
  } catch (failure) {
    // Spec 4.10: the caller's abort travels on as the runtime's `AbortError`.
    if (!isStorageError(failure)) throw failure;

    return failure.providerCode === "NoSuchBucket" ? failure : undefined;
  }
}
