import { type CapabilityName, type ContentHeaders, contentHeadersRefusal } from "@stowage/core";

import { memoryError } from "./storage-error.ts";

/**
 * The content headers as they are held: those `put` was given, each byte for byte, and no
 * member for one it was not, so that a description never carries one as `undefined`.
 * Rejects before anything is written, in the order of spec 4.3.
 */
export function readContentHeaders(
  headers: ContentHeaders,
  contentType: string | undefined,
  key: string,
  capabilities: readonly CapabilityName[],
): ContentHeaders {
  const { cacheControl, contentDisposition, contentLanguage } = headers;
  const snapshot = Object.freeze({
    ...(cacheControl === undefined ? {} : { cacheControl }),
    ...(contentDisposition === undefined ? {} : { contentDisposition }),
    ...(contentLanguage === undefined ? {} : { contentLanguage }),
  });
  const refusal = contentHeadersRefusal(snapshot, contentType, capabilities);

  if (refusal !== undefined) {
    throw memoryError({ ...refusal, operation: "put", key, attempts: 0 });
  }

  return snapshot;
}
