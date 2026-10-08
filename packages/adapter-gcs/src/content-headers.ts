import { type CapabilityName, type ContentHeaders, contentHeadersRefusal } from "@stowage/core";

import { fieldOf, stringOf } from "./json.ts";
import { gcsError } from "./storage-error.ts";

const contentHeaderOptions: readonly (keyof ContentHeaders)[] = [
  "cacheControl",
  "contentDisposition",
  "contentLanguage",
];

/**
 * The content headers as `put` sends them in the object resource, or the refusal of spec 4.3
 * before anything is sent. The check reads a snapshot, so what it passed is what is sent.
 */
export function heldContentHeaders(
  bucket: string,
  headers: ContentHeaders,
  contentType: string,
  key: string,
  capabilities: readonly CapabilityName[],
  operation = "put",
): ContentHeaders {
  const { cacheControl, contentDisposition, contentLanguage } = headers;
  const held: ContentHeaders = Object.freeze({
    ...(cacheControl === undefined ? {} : { cacheControl }),
    ...(contentDisposition === undefined ? {} : { contentDisposition }),
    ...(contentLanguage === undefined ? {} : { contentLanguage }),
  });
  const refusal = contentHeadersRefusal(held, contentType, capabilities);

  if (refusal !== undefined) {
    throw gcsError(bucket, { ...refusal, operation, key, attempts: 0 });
  }

  return held;
}

/**
 * The resource's content headers, with an empty value read as none. The media download is
 * never asked (spec 9.4): GCS serves `private, max-age=0` there where the object stores no
 * `Cache-Control` (spec 10.4).
 */
export function readContentHeaders(resource: unknown): ContentHeaders {
  const held: Partial<Record<keyof ContentHeaders, string>> = {};

  for (const option of contentHeaderOptions) {
    const value = stringOf(fieldOf(resource, option));

    if (value !== undefined) held[option] = value;
  }

  return Object.freeze(held);
}
