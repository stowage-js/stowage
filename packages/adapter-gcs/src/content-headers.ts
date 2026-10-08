import { type CapabilityName, type ContentHeaders, contentHeadersRefusal } from "@stowage/core";

import { fieldOf, stringOf } from "./json.ts";
import type { HeaderField } from "./request.ts";
import { gcsError } from "./storage-error.ts";

const contentHeaderOptions: readonly (keyof ContentHeaders)[] = [
  "cacheControl",
  "contentDisposition",
  "contentLanguage",
];

/** The standard name the XML API takes each content header under, in the order of spec 9.9. */
const signedNames = {
  cacheControl: "cache-control",
  contentDisposition: "content-disposition",
  contentLanguage: "content-language",
} as const satisfies Readonly<Record<keyof ContentHeaders, string>>;

/**
 * The content headers as `put` sends them in the object resource and `presignPut` signs them,
 * or the refusal of spec 4.3 before anything is sent. The check reads a snapshot, so what it
 * passed is what is sent.
 */
export function heldContentHeaders(
  bucket: string,
  headers: ContentHeaders,
  contentType: string,
  key: string,
  operation: "put" | "presignPut",
  capabilities: readonly CapabilityName[],
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

/** The header fields a presigned `PUT` signs and hands back for what passed the check. */
export function signedContentHeaders(held: ContentHeaders): readonly HeaderField[] {
  return contentHeaderOptions.flatMap((option): HeaderField[] => {
    const value = held[option];

    return value === undefined ? [] : [[signedNames[option], value]];
  });
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
