import {
  type CapabilityName,
  checkUserMetadata,
  decodeUserMetadataValue,
  encodeUserMetadataValue,
} from "@stowage/core";

import type { HeaderField } from "./sign.ts";
import { azureBlobError } from "./storage-error.ts";

const headerPrefix = "x-ms-meta-";

/** Spec 8.4: a run Shared Key would fold to one space in the canonical header. */
const whitespaceRun = /\s{2,}/u;

export interface UserMetadataHeaders {
  /** One `x-ms-meta-*` field per key, which is how `Put Blob` carries user metadata. */
  readonly headers: readonly HeaderField[];
  /** The user metadata as a read hands it back: keys folded to lower case. */
  readonly held: Readonly<Record<string, string>>;
}

/**
 * The header fields `userMetadata` travels in, refused before the request is signed in the
 * order of spec 4.3, which reads the refusals off what the storage declares.
 *
 * Keys go out folded to lower case. Azure keeps the case of a name it was sent, but `fetch`
 * hands every header name back in lower case, so a read could not return the case written
 * and a write on a runtime that sends the case as given would store what no read shows.
 */
export function userMetadataHeaders(
  container: string,
  userMetadata: Record<string, string> | undefined,
  key: string,
  capabilities: readonly CapabilityName[],
): UserMetadataHeaders {
  const check = checkUserMetadata(userMetadata, capabilities);

  if ("refusal" in check) {
    throw azureBlobError(container, { ...check.refusal, operation: "put", key, attempts: 0 });
  }

  return {
    headers: Object.entries(check.held).map(([name, value]) => [
      `${headerPrefix}${name}`,
      encodeUserMetadataValue(value, { always: whitespaceRun.test(value) }),
    ]),
    held: check.held,
  };
}

/** The user metadata a `Get Blob` or a `Get Blob Properties` response carries. */
export function readUserMetadata(headers: Headers): Readonly<Record<string, string>> {
  const held: Record<string, string> = Object.create(null);

  for (const [name, value] of headers) {
    if (!name.startsWith(headerPrefix)) continue;

    held[name.slice(headerPrefix.length)] = decodeUserMetadataValue(value);
  }

  return Object.freeze(held);
}
