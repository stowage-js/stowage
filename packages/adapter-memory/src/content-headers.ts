import { type CapabilityName, checkContentHeaders, type ContentHeaders } from "@stowage/core";

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
  const check = checkContentHeaders(headers, contentType, capabilities);

  if ("refusal" in check) {
    throw memoryError({ ...check.refusal, operation: "put", key, attempts: 0 });
  }

  return check.held;
}
