import type { ObjectStat, StorageError } from "@stowage/core";

import { s3Error } from "./storage-error.ts";

export const defaultContentType = "application/octet-stream";

/** A storage that does not declare `userMetadata` reads back none of it (spec 4.9). */
const noUserMetadata: Readonly<Record<string, string>> = Object.freeze({});

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
    userMetadata: noUserMetadata,
  };
}

/**
 * What `put` wrote, described from what it sent: a `PutObject` answer carries the entity
 * tag and the time the provider accepted the object, and neither length nor type. Spec
 * 4.4 has that time come from the provider, so an answer without one is reported rather
 * than dated from this clock.
 */
export function describeWrite(
  bucket: string,
  key: string,
  size: number,
  contentType: string,
  response: Response,
): ObjectStat {
  const accepted = Date.parse(response.headers.get("date") ?? "");

  if (Number.isNaN(accepted)) throw incomplete(bucket, key, "put", "no time it was accepted");

  return {
    key,
    size,
    lastModified: new Date(accepted),
    etag: etagOf(response),
    contentType,
    userMetadata: noUserMetadata,
  };
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
