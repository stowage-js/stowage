import {
  decodeUserMetadataValue,
  encodeUserMetadataValue,
  isUserMetadataKey,
  type StorageError,
  userMetadataByteLength,
} from "@stowage/core";

import type { HeaderField } from "./canonical.ts";
import { s3Error } from "./storage-error.ts";

const headerPrefix = "x-amz-meta-";

/** Spec 4.3 bounds the set at 2 KB of the header bytes it costs once it is encoded. */
const headerByteLimit = 2048;

export interface UserMetadataHeaders {
  /** One `x-amz-meta-*` field per key, which is how `PutObject` carries user metadata. */
  readonly headers: readonly HeaderField[];
  /** The user metadata as the provider hands it back: keys folded to lower case. */
  readonly held: Readonly<Record<string, string>>;
}

/**
 * The header fields `userMetadata` travels in, refused with `InvalidRequest` before the
 * request is signed where a key is no ASCII HTTP token or the whole set is above 2 KB of
 * encoded header bytes (spec 4.3). A key outside ASCII is refused rather than sent,
 * because R2 strips it on the way out and a write would lose it silently (ADR 0014).
 */
export function userMetadataHeaders(
  bucket: string,
  userMetadata: Record<string, string> | undefined,
  key: string,
): UserMetadataHeaders {
  const headers: HeaderField[] = [];
  const held: Record<string, string> = Object.create(null);

  for (const [name, value] of Object.entries(userMetadata ?? {})) {
    if (!isUserMetadataKey(name, "token")) {
      throw refusal(
        bucket,
        `The user metadata key ${JSON.stringify(name)} is no ASCII HTTP token`,
        key,
      );
    }

    const folded = name.toLowerCase();

    // Folding two keys into one would drop a value the caller handed over, and a write
    // that succeeds while losing what it carried is the failure a caller never sees.
    if (folded in held) {
      throw refusal(
        bucket,
        `The user metadata key ${JSON.stringify(folded)} is given more than once`,
        key,
      );
    }

    held[folded] = value;
    headers.push([`${headerPrefix}${folded}`, encodeUserMetadataValue(value)]);
  }

  const headerBytes = userMetadataByteLength(held);

  if (headerBytes > headerByteLimit) {
    throw refusal(
      bucket,
      `The user metadata is ${headerBytes} encoded header bytes, above the limit of ${headerByteLimit}`,
      key,
    );
  }

  return { headers, held: Object.freeze(held) };
}

/**
 * The user metadata a `GET` or a `HEAD` response carries. AWS decodes an encoded word
 * before it stores the value and encodes it again on the way out, in a form of its own
 * choosing, so every form RFC 2047 allows is read and not only the one written.
 */
export function readUserMetadata(headers: Headers): Readonly<Record<string, string>> {
  const held: Record<string, string> = Object.create(null);

  for (const [name, value] of headers) {
    if (!name.startsWith(headerPrefix)) continue;

    held[name.slice(headerPrefix.length)] = decodeUserMetadataValue(value);
  }

  return Object.freeze(held);
}

function refusal(bucket: string, message: string, key: string): StorageError {
  return s3Error(bucket, { code: "InvalidRequest", message, operation: "put", key, attempts: 0 });
}
