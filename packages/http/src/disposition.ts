const utf8 = new TextEncoder();

/**
 * Spec 10.3: the fallback holds no `%XX` and no `\` a recipient might decode, and
 * `filename*` is always sent beside it, so the fallback only has to be harmless.
 */
function contentDisposition(type: "attachment" | "inline", name: string): string {
  if (name === "") return type;

  return `${type}; filename="${fallbackOf(name)}"; filename*=UTF-8''${extendedValueOf(name)}`;
}

/**
 * The `Content-Disposition` of a download of `key`, by default an attachment named after
 * the key's last segment.
 */
export function dispositionOf(
  key: string,
  options: { readonly filename?: string; readonly disposition?: "attachment" | "inline" },
): string {
  return contentDisposition(
    options.disposition ?? "attachment",
    options.filename ?? lastSegmentOf(key),
  );
}

/**
 * Whether a `Content-Disposition` is of the type `attachment`: the token before the first
 * `;`, compared without case. RFC 6266 lets whitespace stand around the `;`.
 */
export function isAttachment(value: string): boolean {
  return value.split(";", 1)[0]?.trim().toLowerCase() === "attachment";
}

/** The name a key gives a download: its last segment, empty for a key ending in `/`. */
function lastSegmentOf(key: string): string {
  return key.slice(key.lastIndexOf("/") + 1);
}

function fallbackOf(name: string): string {
  return Array.from(name, (character) => (isPlainCharacter(character) ? character : "_")).join("");
}

function isPlainCharacter(character: string): boolean {
  const codePoint = character.codePointAt(0) ?? 0;

  return codePoint >= 0x20 && codePoint <= 0x7e && !`"\\%`.includes(character);
}

/** RFC 8187's `attr-char`, which `filename*` carries as it is. */
const attrCharacters = /^[A-Za-z0-9!#$&+\-.^_`|~]$/u;

function extendedValueOf(name: string): string {
  return Array.from(utf8.encode(name), (byte) => {
    const character = String.fromCodePoint(byte);

    return attrCharacters.test(character)
      ? character
      : `%${byte.toString(16).toUpperCase().padStart(2, "0")}`;
  }).join("");
}
