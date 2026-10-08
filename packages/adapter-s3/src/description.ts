import { type ObjectStat, type StorageError, wholeSizeOf } from "@stowage/core";

import { readContentHeaders } from "./content-headers.ts";
import { partialContent } from "./range.ts";
import { s3Error } from "./storage-error.ts";
import { readUserMetadata } from "./user-metadata.ts";

export const defaultContentType = "application/octet-stream";

/** The description a `GET` or a `HEAD` response carries in its headers (spec 4.4). */
export function describeResponse(
  bucket: string,
  key: string,
  operation: string,
  response: Response,
): ObjectStat {
  return {
    key,
    size: sizeOf(bucket, key, operation, response),
    lastModified: lastModifiedOf(bucket, key, operation, response),
    etag: etagOf(response),
    contentType: response.headers.get("content-type") ?? defaultContentType,
    ...readContentHeaders(response.headers),
    userMetadata: readUserMetadata(response.headers),
  };
}

/** What `put` knows of the object it wrote before the provider answered. */
export type WrittenObject = Omit<ObjectStat, "lastModified" | "etag">;

/**
 * What `put` wrote, described from what it sent: a `PutObject` answer carries the entity
 * tag and the time the provider accepted the object, and neither length, type nor content
 * headers. Spec 4.4 has that time come from the provider, so an answer without one is
 * reported rather than dated from this clock. `CompleteMultipartUpload` carries its entity
 * tag in the body instead, and hands it in as `etag`.
 */
export function describeWrite(
  bucket: string,
  written: WrittenObject,
  response: Response,
  etag: string | undefined = etagOf(response),
): ObjectStat {
  const accepted = Date.parse(response.headers.get("date") ?? "");

  if (Number.isNaN(accepted)) {
    throw incomplete(bucket, written.key, "put", "no time it was accepted");
  }

  return { ...written, lastModified: new Date(accepted), etag };
}

function etagOf(response: Response): string | undefined {
  const etag = response.headers.get("etag");

  if (etag === null) return undefined;

  return unquotedEtag(etag);
}

// The quotes belong to the header field and to the listing XML rather than to the value,
// which spec 4.4 leaves opaque; stripping them is what makes `get`, `stat` and a listing
// answer the same string.
export function unquotedEtag(etag: string): string {
  return etag.replace(/^"|"$/gu, "");
}

function sizeOf(bucket: string, key: string, operation: string, response: Response): number {
  if (response.status === partialContent) {
    const size = wholeSizeOf(response.headers.get("content-range"));

    if (size === undefined) throw incomplete(bucket, key, operation, "no size of the whole object");

    return size;
  }

  const header = response.headers.get("content-length");

  if (header === null || header.trim() === "") {
    throw incomplete(bucket, key, operation, "no length");
  }

  const length = Number(header);

  if (!Number.isInteger(length) || length < 0) {
    throw incomplete(bucket, key, operation, "no length");
  }

  return length;
}

function lastModifiedOf(bucket: string, key: string, operation: string, response: Response): Date {
  const modified = Date.parse(response.headers.get("last-modified") ?? "");

  if (Number.isNaN(modified)) throw incomplete(bucket, key, operation, "no last-modified time");

  return new Date(modified);
}

// Spec 4.6 makes a description that arrives without one of its three parts a
// `ProviderError` rather than a description with a value invented for it.
function incomplete(bucket: string, key: string, operation: string, missing: string): StorageError {
  return s3Error(bucket, {
    code: "ProviderError",
    message: `The provider described the object under ${JSON.stringify(key)} with ${missing}`,
    operation,
    key,
    attempts: 1,
  });
}
