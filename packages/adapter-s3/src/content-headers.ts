import { type CapabilityName, checkContentHeaders, type ContentHeaders } from "@stowage/core";

import type { HeaderField } from "./canonical.ts";
import { s3Error } from "./storage-error.ts";

const headerNames = {
  cacheControl: "cache-control",
  contentDisposition: "content-disposition",
  contentLanguage: "content-language",
} as const satisfies Readonly<Record<keyof ContentHeaders, string>>;

const contentHeaderOptions: readonly (keyof ContentHeaders)[] = [
  "cacheControl",
  "contentDisposition",
  "contentLanguage",
];

export interface ContentHeaderFields {
  /**
   * What `PutObject` and `CreateMultipartUpload` carry the content headers in, and what a
   * presigned `PutObject` signs.
   */
  readonly headers: readonly HeaderField[];
  /** The content headers as the provider stores them: each byte for byte, none `undefined`. */
  readonly held: ContentHeaders;
}

/**
 * The header fields the content headers travel in, refused before the request is signed in
 * the order of spec 4.3. AWS and R2 store each value as sent, so what was sent is what a later
 * `stat` reports.
 */
export function contentHeaderFields(
  bucket: string,
  headers: ContentHeaders,
  contentType: string,
  key: string,
  operation: "put" | "presignPut",
  capabilities: readonly CapabilityName[],
): ContentHeaderFields {
  const check = checkContentHeaders(headers, contentType, capabilities);

  if ("refusal" in check) {
    throw s3Error(bucket, { ...check.refusal, operation, key, attempts: 0 });
  }

  const { held } = check;

  return {
    headers: contentHeaderOptions.flatMap((option): HeaderField[] => {
      const value = held[option];

      return value === undefined ? [] : [[headerNames[option], value]];
    }),
    held,
  };
}

/**
 * The content headers a `GET` or a `HEAD` response carries, with an empty value read as
 * none: AWS stores `Cache-Control:` as empty where R2 stores none (spec 4.4).
 */
export function readContentHeaders(headers: Headers): ContentHeaders {
  const held: Partial<Record<keyof ContentHeaders, string>> = {};

  for (const option of contentHeaderOptions) {
    const value = headers.get(headerNames[option]);

    if (value !== null && value !== "") held[option] = value;
  }

  return Object.freeze(held);
}
