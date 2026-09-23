import type { StorageError } from "@stowage/core";

import type { HeaderField } from "./canonical.ts";
import { s3Error } from "./storage-error.ts";

const headerPrefix = "x-amz-meta-";

/** Spec 4.3 bounds the set at 2 KB of the header bytes it costs once it is encoded. */
const headerByteLimit = 2048;

/** The characters RFC 9110 allows in a field name, which is what a user metadata key is. */
const httpToken = /^[!#$%&'*+.^_`|~\dA-Za-z-]+$/u;

/**
 * What survives a header field as it stands: printable ASCII with no space at either end,
 * which HTTP trims, and no `=?`, which the reader would take for the start of an encoded
 * word.
 */
const travelsAsWritten = /^(?:[\x21-\x7e](?:[\x20-\x7e]*[\x21-\x7e])?)?$/u;

const encodedWordStart = "=?UTF-8?B?";
const encodedWordEnd = "?=";

/**
 * RFC 2047 bounds an encoded word at 75 characters; 45 bytes are 60 characters of base64,
 * which leaves room for the 12 the word's frame costs.
 */
const bytesPerEncodedWord = 45;

const utf8 = new TextEncoder();

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
  let headerBytes = 0;

  for (const [name, value] of Object.entries(userMetadata ?? {})) {
    if (!httpToken.test(name)) {
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

    const encoded = encodeValue(value);

    held[folded] = value;
    headers.push([`${headerPrefix}${folded}`, encoded]);
    // Every byte on the wire is ASCII once the value is encoded, so length is bytes.
    headerBytes += folded.length + encoded.length;
  }

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

    held[name.slice(headerPrefix.length)] = decodeValue(value);
  }

  return Object.freeze(held);
}

function encodeValue(value: string): string {
  if (travelsAsWritten.test(value) && !value.includes("=?")) return value;

  return utf8PiecesOf(value)
    .map((piece) => `${encodedWordStart}${btoa(String.fromCharCode(...piece))}${encodedWordEnd}`)
    .join(" ");
}

/** The UTF-8 bytes in pieces of at most one encoded word, each ending on a character. */
function utf8PiecesOf(value: string): readonly Uint8Array[] {
  const pieces: Uint8Array[] = [];
  let pending: number[] = [];

  for (const character of value) {
    const bytes = utf8.encode(character);

    if (pending.length + bytes.length > bytesPerEncodedWord) {
      pieces.push(Uint8Array.from(pending));
      pending = [];
    }

    pending.push(...bytes);
  }

  pieces.push(Uint8Array.from(pending));

  return pieces;
}

const encodedWord = /=\?([^?\s]+)\?([BbQq])\?([^?\s]*)\?=/gu;
const whitespaceOnly = /^[ \t]+$/u;
const hexPair = /^[\dA-Fa-f]{2}$/u;

function decodeValue(value: string): string {
  let decoded = "";
  let last = 0;
  let previousWasEncoded = false;

  for (const match of value.matchAll(encodedWord)) {
    const between = value.slice(last, match.index);
    const word = decodeWord(match[1] ?? "", match[2] ?? "", match[3] ?? "");

    // RFC 2047, section 6.2: the space between two adjacent encoded words is no text.
    if (!(previousWasEncoded && word !== undefined && whitespaceOnly.test(between))) {
      decoded += between;
    }

    decoded += word ?? match[0];
    previousWasEncoded = word !== undefined;
    last = match.index + match[0].length;
  }

  return decoded + value.slice(last);
}

/** The text of one encoded word, or `undefined` where it names what cannot be read. */
function decodeWord(charset: string, encoding: string, text: string): string | undefined {
  const bytes = encoding.toUpperCase() === "B" ? base64Bytes(text) : quotedBytes(text);

  if (bytes === undefined) return undefined;

  try {
    return new TextDecoder(charset, { fatal: true }).decode(bytes);
  } catch {
    // A charset the runtime does not know, or bytes that are not in it.
    return undefined;
  }
}

function base64Bytes(text: string): Uint8Array | undefined {
  try {
    return Uint8Array.from(atob(text), (character) => character.charCodeAt(0));
  } catch {
    return undefined;
  }
}

/** The `Q` encoding: `_` is a space and `=XX` one byte in hex. */
function quotedBytes(text: string): Uint8Array | undefined {
  const bytes: number[] = [];

  for (let index = 0; index < text.length; index += 1) {
    const character = text[index];

    if (character === "_") {
      bytes.push(0x20);
    } else if (character === "=") {
      const pair = text.slice(index + 1, index + 3);

      if (!hexPair.test(pair)) return undefined;

      bytes.push(Number.parseInt(pair, 16));
      index += 2;
    } else {
      bytes.push(text.charCodeAt(index));
    }
  }

  return Uint8Array.from(bytes);
}

function refusal(bucket: string, message: string, key: string): StorageError {
  return s3Error(bucket, { code: "InvalidRequest", message, operation: "put", key, attempts: 0 });
}
