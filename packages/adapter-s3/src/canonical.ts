export type HeaderField = readonly [name: string, value: string];
export type QueryParameter = readonly [name: string, value: string];

/** What `encodeURIComponent` leaves alone and RFC 3986 counts as reserved. */
const reservedByEncodeUriComponent = /[!'()*]/g;

/** Runs of whitespace inside a header value, which SigV4 folds to one space. */
const whitespaceRun = /\s+/g;

export function encodeRfc3986(value: string): string {
  return encodeURIComponent(value).replace(
    reservedByEncodeUriComponent,
    (character) => `%${character.charCodeAt(0).toString(16).toUpperCase()}`,
  );
}

/**
 * The canonical URI: the path percent-encoded segment by segment, so that a slash stays
 * a slash and `#`, `%`, `?`, `+`, a space and everything above ASCII travel encoded
 * (spec 7.4). S3 encodes the path once and normalizes nothing, which is why no `URL` is
 * built from it: the constructor folds a `..` segment away and decodes what it was
 * handed, and both would sign a path other than the one the request carries.
 */
export function encodePath(path: string): string {
  return path.split("/").map(encodeRfc3986).join("/");
}

/** The canonical query string: every pair encoded, sorted by name and then by value. */
export function encodeQuery(query: readonly QueryParameter[]): string {
  return query
    .map(([name, value]): QueryParameter => [encodeRfc3986(name), encodeRfc3986(value)])
    .toSorted(compareFields)
    .map(([name, value]) => `${name}=${value}`)
    .join("&");
}

export interface CanonicalHeaders {
  /** One `name:value` line per field, each closed by a newline. */
  readonly lines: string;
  /** The names those lines carry, semicolon-separated. */
  readonly names: string;
}

/**
 * The canonical headers: names folded to lower case, values trimmed with their inner
 * runs of whitespace folded to one space, fields of one name joined in the order they
 * arrived, and the whole sorted by name.
 */
export function canonicalHeaders(fields: readonly HeaderField[]): CanonicalHeaders {
  const joined = new Map<string, string>();

  for (const [name, value] of fields) {
    const folded = name.toLowerCase();
    const trimmed = value.trim().replace(whitespaceRun, " ");
    const held = joined.get(folded);

    joined.set(folded, held === undefined ? trimmed : `${held},${trimmed}`);
  }

  const sorted = [...joined].toSorted(compareFields);

  return {
    lines: sorted.map(([name, value]) => `${name}:${value}\n`).join(""),
    names: sorted.map(([name]) => name).join(";"),
  };
}

// Percent-encoding and case folding leave ASCII alone, so comparing the code units is
// comparing the bytes SigV4 orders by.
function compareFields(one: readonly [string, string], other: readonly [string, string]): number {
  if (one[0] !== other[0]) return one[0] < other[0] ? -1 : 1;
  if (one[1] !== other[1]) return one[1] < other[1] ? -1 : 1;

  return 0;
}
