import type { ObjectStat, StorageError } from "@stowage/core";

import { requestIdHeader } from "./request.ts";
import { gcsError } from "./storage-error.ts";

export const defaultContentType = "application/octet-stream";

/** Until the storage reads `metadata` off the resource, every object reads as holding none. */
const noUserMetadata: Readonly<Record<string, string>> = Object.freeze(Object.create(null));

/** A decimal count of bytes, which the JSON API sends as a string to keep 64 bits whole. */
const decimalSize = /^(?:0|[1-9]\d*)$/u;

/**
 * The object resource the JSON API answers a metadata read and an upload with, read to the
 * end. A body that is no JSON is a `ProviderError` rather than a description made up.
 */
export async function readResource(
  bucket: string,
  key: string,
  operation: string,
  response: Response,
): Promise<unknown> {
  try {
    return await response.json();
  } catch (failure) {
    if (failure instanceof Error && failure.name === "AbortError") throw failure;

    throw incomplete(bucket, key, operation, response, "a body that is no JSON", failure);
  }
}

/**
 * Spec 4.4 out of the object resource: `size`, the time of `updated` and the `etag`. The
 * key is the one the call named, which the resource's `name` repeats byte for byte.
 */
export function describeResource(
  bucket: string,
  key: string,
  operation: string,
  response: Response,
  resource: unknown,
): ObjectStat {
  const size = fieldOf(resource, "size");
  const updated = fieldOf(resource, "updated");
  const modified = typeof updated === "string" ? Date.parse(updated) : Number.NaN;
  const etag = fieldOf(resource, "etag");
  const contentType = fieldOf(resource, "contentType");

  if (typeof size !== "string" || !decimalSize.test(size)) {
    throw incomplete(bucket, key, operation, response, "no size");
  }

  if (Number.isNaN(modified)) {
    throw incomplete(bucket, key, operation, response, "no last-modified time");
  }

  return {
    key,
    size: Number(size),
    lastModified: new Date(modified),
    ...(typeof etag === "string" && etag !== "" ? { etag } : {}),
    contentType:
      typeof contentType === "string" && contentType !== "" ? contentType : defaultContentType,
    userMetadata: noUserMetadata,
  };
}

function fieldOf(value: unknown, name: string): unknown {
  return typeof value === "object" && value !== null ? Reflect.get(value, name) : undefined;
}

// Spec 4.6 makes a description that arrives without one of its parts a `ProviderError`
// rather than a description with a value invented for it.
function incomplete(
  bucket: string,
  key: string,
  operation: string,
  response: Response,
  missing: string,
  cause?: unknown,
): StorageError {
  return gcsError(bucket, {
    code: "ProviderError",
    message: `The provider described the object under ${JSON.stringify(key)} with ${missing}`,
    operation,
    key,
    attempts: 1,
    status: response.status,
    requestId: response.headers.get(requestIdHeader) ?? undefined,
    cause,
  });
}
