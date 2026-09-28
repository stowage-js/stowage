import type { CapabilityName } from "./capabilities.ts";
import type { Refusal } from "./errors.ts";

export type UserMetadataKeyRule = "token" | "identifier";

const keyPatterns: Readonly<Record<UserMetadataKeyRule, RegExp>> = {
  /** The characters RFC 9110 allows in a field name, which is what a header carries. */
  token: /^[!#$%&'*+.^_`|~\dA-Za-z-]+$/u,
  /** An ASCII identifier, which Azure requires of a metadata name (ADR 0020). */
  identifier: /^[A-Za-z_][A-Za-z\d_]*$/u,
};

export function isUserMetadataKey(name: string, rule: UserMetadataKeyRule): boolean {
  return keyPatterns[rule].test(name);
}

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

/** The value as a header carries it: as written where it travels so, else as encoded words. */
export function encodeUserMetadataValue(value: string, options?: { always?: boolean }): string {
  if (value === "") return value;
  if (options?.always !== true && travelsAsWritten.test(value) && !value.includes("=?")) {
    return value;
  }

  return utf8PiecesOf(value)
    .map((piece) => `${encodedWordStart}${btoa(String.fromCharCode(...piece))}${encodedWordEnd}`)
    .join(" ");
}

/**
 * What spec 4.3 bounds at 2 KB: every key and its value as `encodeUserMetadataValue` writes
 * it, without `always`, so the bound does not depend on what an adapter encodes beyond the rule.
 */
export function userMetadataByteLength(userMetadata: Readonly<Record<string, string>>): number {
  let bytes = 0;

  for (const [name, value] of Object.entries(userMetadata)) {
    // An encoded value is ASCII, so its length is its bytes.
    bytes += utf8.encode(name).length + encodeUserMetadataValue(value).length;
  }

  return bytes;
}

export type UserMetadataCheck =
  | { readonly held: Readonly<Record<string, string>> }
  | { readonly refusal: Refusal };

/** Spec 4.3 bounds the set at 2 KB of the header bytes it costs once it is encoded. */
const headerByteLimit = 2048;

const noUserMetadata: UserMetadataCheck = { held: Object.freeze(Object.create(null)) };

/**
 * The user metadata as a storage holds it, keys folded to lower case as a header field name
 * is, or the first refusal of spec 4.3, read off what the storage declares.
 */
export function checkUserMetadata(
  userMetadata: Record<string, string> | undefined,
  capabilities: readonly CapabilityName[],
): UserMetadataCheck {
  const entries = Object.entries(userMetadata ?? {});

  if (entries.length === 0) return noUserMetadata;

  if (!capabilities.includes("userMetadata")) {
    return unsupported("userMetadata", "This storage holds no user metadata");
  }

  const held: Record<string, string> = Object.create(null);

  for (const [name, value] of entries) {
    if (!isUserMetadataKey(name, "token")) {
      return refused(`The user metadata key ${JSON.stringify(name)} is no ASCII HTTP token`);
    }

    const folded = name.toLowerCase();

    // Folding two keys into one would drop a value the caller handed over, and a write
    // that succeeds while losing what it carried is the failure a caller never sees.
    if (folded in held) {
      return refused(`The user metadata key ${JSON.stringify(folded)} is given more than once`);
    }

    held[folded] = value;
  }

  // The bound below measures the UTF-8 form, which a lone surrogate lacks: the encoder
  // would count and send U+FFFD in its place.
  const malformed = Object.entries(held).find(([, value]) => !value.isWellFormed());

  if (malformed !== undefined) {
    return refused(
      `The user metadata value of ${JSON.stringify(malformed[0])} holds a lone surrogate, which has no UTF-8 form`,
    );
  }

  const headerBytes = userMetadataByteLength(held);

  if (headerBytes > headerByteLimit) {
    return refused(
      `The user metadata is ${headerBytes} encoded header bytes, above the limit of ${headerByteLimit}`,
    );
  }

  const beyondIdentifiers = entries.find(([name]) => !isUserMetadataKey(name, "identifier"));

  if (beyondIdentifiers !== undefined && !capabilities.includes("userMetadataTokenKeys")) {
    return unsupported(
      "userMetadataTokenKeys",
      `This storage holds no user metadata key beyond identifiers, such as ${JSON.stringify(beyondIdentifiers[0])}`,
    );
  }

  return { held: Object.freeze(held) };
}

function refused(message: string): UserMetadataCheck {
  return { refusal: { code: "InvalidRequest", message } };
}

function unsupported(capability: CapabilityName, message: string): UserMetadataCheck {
  return { refusal: { code: "Unsupported", message, capability } };
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

/** A header value read back, with every form of encoded word RFC 2047 allows decoded. */
export function decodeUserMetadataValue(value: string): string {
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
