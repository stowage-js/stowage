import type { ObjectStat, StorageError } from "@stowage/core";

import { azureBlobError } from "./storage-error.ts";

export const defaultContentType = "application/octet-stream";

/** Until the storage declares `userMetadata`, every object reads as holding none. */
const noUserMetadata: Readonly<Record<string, string>> = Object.freeze(Object.create(null));

/** The description a `Get Blob` response carries in its headers (spec 4.4). */
export function describeResponse(
  container: string,
  key: string,
  operation: string,
  response: Response,
): ObjectStat {
  return {
    key,
    size: sizeOf(container, key, operation, response),
    lastModified: lastModifiedOf(container, key, operation, response),
    etag: etagOf(response),
    contentType: response.headers.get("content-type") ?? defaultContentType,
    userMetadata: noUserMetadata,
  };
}

/**
 * What `put` wrote, described from what it sent and what `Put Blob` answered: the entity
 * tag and the time the service wrote the blob, and neither length nor type. Spec 4.4 has
 * that time come from the provider, so an answer without one is reported rather than
 * dated from this clock.
 */
export function describeWrite(
  container: string,
  key: string,
  size: number,
  contentType: string,
  response: Response,
): ObjectStat {
  return {
    key,
    size,
    lastModified: lastModifiedOf(container, key, "put", response),
    etag: etagOf(response),
    contentType,
    userMetadata: noUserMetadata,
  };
}

function etagOf(response: Response): string | undefined {
  const etag = response.headers.get("etag");

  return etag === null ? undefined : unquotedEtag(etag);
}

// The quotes belong to the header field and to the listing XML rather than to the value,
// which spec 4.4 leaves opaque; stripping them is what makes `get`, `stat` and a listing
// answer the same string.
export function unquotedEtag(etag: string): string {
  return etag.replace(/^"|"$/gu, "");
}

function sizeOf(container: string, key: string, operation: string, response: Response): number {
  const header = response.headers.get("content-length");
  const length = header === null || header.trim() === "" ? Number.NaN : Number(header);

  if (!Number.isInteger(length) || length < 0) {
    throw incomplete(container, key, operation, "no length");
  }

  return length;
}

function lastModifiedOf(
  container: string,
  key: string,
  operation: string,
  response: Response,
): Date {
  const modified = Date.parse(response.headers.get("last-modified") ?? "");

  if (Number.isNaN(modified)) throw incomplete(container, key, operation, "no last-modified time");

  return new Date(modified);
}

// Spec 4.6 makes a description that arrives without one of its three parts a
// `ProviderError` rather than a description with a value invented for it.
function incomplete(
  container: string,
  key: string,
  operation: string,
  missing: string,
): StorageError {
  return azureBlobError(container, {
    code: "ProviderError",
    message: `The provider described the object under ${JSON.stringify(key)} with ${missing}`,
    operation,
    key,
    attempts: 1,
  });
}
