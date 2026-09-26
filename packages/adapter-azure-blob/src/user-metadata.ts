import {
  type CapabilityName,
  decodeUserMetadataValue,
  encodeUserMetadataValue,
  isUserMetadataKey,
  type StorageError,
  userMetadataByteLength,
} from "@stowage/core";

import type { HeaderField } from "./sign.ts";
import { azureBlobError } from "./storage-error.ts";

const headerPrefix = "x-ms-meta-";

/** Spec 4.3 bounds the set at 2 KB of the header bytes it costs once it is encoded. */
const headerByteLimit = 2048;

/** Spec 8.4: a run Shared Key would fold to one space in the canonical header. */
const whitespaceRun = /\s{2,}/u;

export interface UserMetadataHeaders {
  /** One `x-ms-meta-*` field per key, which is how `Put Blob` carries user metadata. */
  readonly headers: readonly HeaderField[];
  /** The user metadata as a read hands it back: keys folded to lower case. */
  readonly held: Readonly<Record<string, string>>;
}

const noUserMetadata: UserMetadataHeaders = {
  headers: [],
  held: Object.freeze(Object.create(null)),
};

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
  const entries = Object.entries(userMetadata ?? {});

  if (entries.length === 0) return noUserMetadata;

  if (!capabilities.includes("userMetadata")) {
    throw unsupported(container, "userMetadata", "This storage holds no user metadata", key);
  }

  const headers: HeaderField[] = [];
  const held: Record<string, string> = Object.create(null);

  for (const [name, value] of entries) {
    if (!isUserMetadataKey(name, "token")) {
      throw refusal(
        container,
        `The user metadata key ${JSON.stringify(name)} is no ASCII HTTP token`,
        key,
      );
    }

    const folded = name.toLowerCase();

    // Folding two keys into one would drop a value the caller handed over, and a write
    // that succeeds while losing what it carried is the failure a caller never sees.
    if (folded in held) {
      throw refusal(
        container,
        `The user metadata key ${JSON.stringify(folded)} is given more than once`,
        key,
      );
    }

    held[folded] = value;
    headers.push([
      `${headerPrefix}${folded}`,
      encodeUserMetadataValue(value, { always: whitespaceRun.test(value) }),
    ]);
  }

  const headerBytes = userMetadataByteLength(held);

  if (headerBytes > headerByteLimit) {
    throw refusal(
      container,
      `The user metadata is ${headerBytes} encoded header bytes, above the limit of ${headerByteLimit}`,
      key,
    );
  }

  const beyondIdentifiers = entries.find(([name]) => !isUserMetadataKey(name, "identifier"));

  if (beyondIdentifiers !== undefined && !capabilities.includes("userMetadataTokenKeys")) {
    throw unsupported(
      container,
      "userMetadataTokenKeys",
      `This storage holds no user metadata key beyond identifiers, such as ${JSON.stringify(beyondIdentifiers[0])}`,
      key,
    );
  }

  return { headers, held: Object.freeze(held) };
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

function refusal(container: string, message: string, key: string): StorageError {
  return azureBlobError(container, {
    code: "InvalidRequest",
    message,
    operation: "put",
    key,
    attempts: 0,
  });
}

function unsupported(
  container: string,
  capability: CapabilityName,
  message: string,
  key: string,
): StorageError {
  return azureBlobError(container, {
    code: "Unsupported",
    message,
    operation: "put",
    key,
    attempts: 0,
    capability,
  });
}
