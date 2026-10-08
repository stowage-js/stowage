import { type CapabilityName, checkContentHeaders, type ContentHeaders } from "@stowage/core";

import type { HeaderField } from "./sign.ts";
import { azureBlobError } from "./storage-error.ts";

const contentHeaderOptions: readonly (keyof ContentHeaders)[] = [
  "cacheControl",
  "contentDisposition",
  "contentLanguage",
];

/**
 * ADR 0059: `Put Block List` takes the `x-ms-blob-*` forms alone, and Azurite drops the
 * standard `Cache-Control` and `Content-Language` on `Put Blob`, so both requests send these.
 */
const sentNames = {
  cacheControl: "x-ms-blob-cache-control",
  contentDisposition: "x-ms-blob-content-disposition",
  contentLanguage: "x-ms-blob-content-language",
} as const satisfies Readonly<Record<keyof ContentHeaders, string>>;

const answeredNames = {
  cacheControl: "cache-control",
  contentDisposition: "content-disposition",
  contentLanguage: "content-language",
} as const satisfies Readonly<Record<keyof ContentHeaders, string>>;

export interface ContentHeaderFields {
  /**
   * What `Put Blob` and `Put Block List` carry the content headers in, and what the SAS of
   * `presignPut` names in `srh`, in the order of spec 8.9.
   */
  readonly headers: readonly HeaderField[];
  /** The content headers as the service stores them: each byte for byte, none `undefined`. */
  readonly held: ContentHeaders;
}

/**
 * The header fields the content headers travel in, refused before the request is signed in
 * the order of spec 4.3. Shared Key signs each value trimmed and otherwise as sent (spec 8.4),
 * and the core lets no value through that trimming changes.
 */
export function contentHeaderFields(
  container: string,
  headers: ContentHeaders,
  contentType: string,
  key: string,
  operation: "put" | "presignPut",
  capabilities: readonly CapabilityName[],
): ContentHeaderFields {
  const check = checkContentHeaders(headers, contentType, capabilities);

  if ("refusal" in check) {
    throw azureBlobError(container, { ...check.refusal, operation, key, attempts: 0 });
  }

  const { held } = check;

  return {
    headers: contentHeaderOptions.flatMap((option): HeaderField[] => {
      const value = held[option];

      return value === undefined ? [] : [[sentNames[option], value]];
    }),
    held,
  };
}

/** The content headers a `Get Blob` or a `Get Blob Properties` response carries (spec 8.4). */
export function readContentHeaders(headers: Headers): ContentHeaders {
  const held: Partial<Record<keyof ContentHeaders, string>> = {};

  for (const option of contentHeaderOptions) {
    const value = headers.get(answeredNames[option]);

    if (value !== null && value !== "") held[option] = value;
  }

  return Object.freeze(held);
}
