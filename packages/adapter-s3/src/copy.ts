import { isStorageError, type ObjectStat } from "@stowage/core";

import { readAnswerDocument } from "./answer-document.ts";
import { encodePath } from "./canonical.ts";
import type { S3Configuration } from "./configuration.ts";
import { describeResponse } from "./description.ts";
import { send } from "./request.ts";
import { inStorage } from "./storage-error.ts";

/**
 * Spec 7.8: one `CopyObject`, with the provider's refusal of a source too large for it as
 * the answer rather than a fallback to `UploadPartCopy` (ADR 0016). S3's default
 * directive keeps the source's content type and user metadata, which spec 4.11 asks of a
 * copy. Its answer names neither the size nor the user metadata of what it wrote, so a `HEAD`
 * of the destination describes it.
 */
export async function copyObject(
  configuration: S3Configuration,
  from: string,
  to: string,
  operation: string,
  signal: AbortSignal | undefined,
): Promise<ObjectStat> {
  const { bucket } = configuration;

  signal?.throwIfAborted();

  const response = await send(configuration, {
    method: "PUT",
    operation,
    key: to,
    // The source is named as the bucket and the key, never as the path the destination
    // is addressed through, and it is percent-encoded as the path is.
    headers: [["x-amz-copy-source", encodePath(`/${bucket}/${from}`)]],
    signal,
  }).catch((failure: unknown) => {
    // The request addresses the destination, and the key it did not find is the source.
    if (isStorageError(failure) && failure.providerCode === "NoSuchKey") {
      throw inStorage(failure, bucket, operation, from);
    }

    throw failure;
  });

  await readAnswerDocument(
    { bucket, operation, key: to, subject: "the copy" },
    response,
    "CopyObjectResult",
  );

  const described = await send(configuration, { method: "HEAD", operation, key: to, signal });

  return describeResponse(bucket, to, operation, described);
}
