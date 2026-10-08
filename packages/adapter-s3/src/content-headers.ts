import { type CapabilityName, type ContentHeaders, contentHeadersRefusal } from "@stowage/core";

import type { HeaderField } from "./canonical.ts";
import { s3Error } from "./storage-error.ts";

/** Each content header beside the option and the `ObjectStat` member it is read into. */
const headerNames: Readonly<Record<keyof ContentHeaders, string>> = {
  cacheControl: "cache-control",
  contentDisposition: "content-disposition",
  contentLanguage: "content-language",
};

export interface ContentHeaderFields {
  /** What `PutObject` and `CreateMultipartUpload` carry the content headers in. */
  readonly headers: readonly HeaderField[];
  /** The content headers as the provider stores them: each byte for byte, none `undefined`. */
  readonly held: ContentHeaders;
}

/**
 * The header fields the content headers travel in, refused before the request is signed in
 * the order of spec 4.3. AWS and R2 store each value as sent, so what was sent is what a
 * later `stat` reports.
 */
export function contentHeaderFields(
  bucket: string,
  headers: ContentHeaders,
  contentType: string,
  key: string,
  capabilities: readonly CapabilityName[],
): ContentHeaderFields {
  const refusal = contentHeadersRefusal(headers, contentType, capabilities);

  if (refusal !== undefined) {
    throw s3Error(bucket, { ...refusal, operation: "put", key, attempts: 0 });
  }

  const fields: HeaderField[] = [];
  const held: Record<string, string> = {};

  for (const [option, name] of Object.entries(headerNames)) {
    const value: unknown = Reflect.get(headers, option);

    if (typeof value !== "string") continue;

    fields.push([name, value]);
    held[option] = value;
  }

  return { headers: fields, held: Object.freeze(held) };
}

/**
 * The content headers a `GET` or a `HEAD` response carries, with an empty value read as
 * none: AWS stores `Cache-Control:` as empty where R2 stores none (spec 4.4).
 */
export function readContentHeaders(headers: Headers): ContentHeaders {
  const held: Record<string, string> = {};

  for (const [option, name] of Object.entries(headerNames)) {
    const value = headers.get(name);

    if (value !== null && value !== "") held[option] = value;
  }

  return held;
}
