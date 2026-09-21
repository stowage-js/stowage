import { memoryError } from "./storage-error.ts";

/** Spec 4.3 bounds the set at 2 KB of the header bytes it costs once it is encoded. */
const headerByteLimit = 2048;

/** The characters RFC 9110 allows in a field name, which is what a metadata key is. */
const httpToken = /^[!#$%&'*+.^_`|~\dA-Za-z-]+$/;

/** What travels in a header field as it stands, so it costs one byte per character. */
const bareValue = /^[\x20-\x7e]*$/;

/** `=?UTF-8?B?` and the `?=` that closes it. */
const encodedWordOverhead = 12;

const utf8 = new TextEncoder();

/**
 * The metadata as it is held: keys folded to lower case, as a header field name is.
 * Rejects with `InvalidRequest` before anything is written (spec 4.3).
 */
export function readUserMetadata(
  userMetadata: Record<string, string> | undefined,
  key: string,
): Readonly<Record<string, string>> {
  const held: Record<string, string> = {};
  let headerBytes = 0;

  for (const [name, value] of Object.entries(userMetadata ?? {})) {
    if (!httpToken.test(name)) {
      throw refusal(`The metadata key ${JSON.stringify(name)} is no ASCII HTTP token`, key);
    }

    const folded = name.toLowerCase();

    // Folding two keys into one would drop a value the caller handed over, and a write
    // that succeeds while losing what it carried is the failure a caller never sees.
    if (folded in held) {
      throw refusal(`The metadata key ${JSON.stringify(folded)} is given more than once`, key);
    }

    held[folded] = value;
    headerBytes += folded.length + encodedValueBytes(value);
  }

  if (headerBytes > headerByteLimit) {
    throw refusal(
      `The metadata is ${headerBytes} encoded header bytes, above the limit of ${headerByteLimit}`,
      key,
    );
  }

  return Object.freeze(held);
}

// A value above ASCII reaches the provider as an RFC 2047 encoded word, so it costs the
// base64 of its UTF-8 bytes rather than those bytes (spec 4.3).
function encodedValueBytes(value: string): number {
  if (bareValue.test(value)) return value.length;

  return encodedWordOverhead + 4 * Math.ceil(utf8.encode(value).length / 3);
}

function refusal(message: string, key: string): Error {
  return memoryError({ code: "InvalidRequest", message, operation: "put", key, attempts: 0 });
}
