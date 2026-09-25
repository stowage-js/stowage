import { accountKeyBytes } from "./credentials.ts";

export type HeaderField = readonly [name: string, value: string];
export type QueryParameter = readonly [name: string, value: string];

export interface SignableRequest {
  readonly method: string;
  readonly account: string;
  /** Encoded as the request line carries it, which is how Shared Key signs it. */
  readonly path: string;
  /** Decoded, as the canonicalized resource carries it. */
  readonly query: readonly QueryParameter[];
  /** What the request carries; `x-ms-date` is added here. */
  readonly headers: readonly HeaderField[];
  /** `fetch` sets `Content-Length` from the body and refuses to be handed one. */
  readonly contentLength: number;
  readonly date: Date;
}

export interface SignedRequest {
  /** What to send, `x-ms-date` and `authorization` among it. */
  readonly headers: readonly HeaderField[];
  /** Nothing sends it; a fixture that fails on it says which line went wrong. */
  readonly stringToSign: string;
}

/**
 * The standard headers of the string to sign, in its order. `Content-Length` takes the
 * fourth line apart from these, and `Date` stays empty: `fetch` forbids setting it, so
 * `x-ms-date` carries the time through the canonical headers instead.
 */
const leadingHeaders = ["content-encoding", "content-language"] as const;
const trailingHeaders = [
  "content-md5",
  "content-type",
  "date",
  "if-modified-since",
  "if-match",
  "if-none-match",
  "if-unmodified-since",
  "range",
] as const;

const canonicalPrefix = "x-ms-";

const whitespaceRun = /\s+/gu;

const utf8 = new TextEncoder();

/** Spec 8.4: a request under an account key is signed with Shared Key. */
export async function signSharedKey(
  request: SignableRequest,
  accountKey: string,
): Promise<SignedRequest> {
  const headers: readonly HeaderField[] = [
    ...request.headers,
    ["x-ms-date", request.date.toUTCString()],
  ];
  const signed = stringToSign({ ...request, headers });
  const signature = await hmacSha256Base64(accountKey, signed);

  return {
    headers: [...headers, ["authorization", `SharedKey ${request.account}:${signature}`]],
    stringToSign: signed,
  };
}

/** The Shared Key string to sign for Blob, unchanged in shape since `2016-05-31`. */
export function stringToSign(request: Omit<SignableRequest, "date">): string {
  const fields = new Map<string, string>();

  for (const [name, value] of request.headers) fields.set(name.toLowerCase(), value);

  const standard = (name: string): string => fields.get(name) ?? "";
  // Since `2015-02-21` a body of zero bytes signs an empty length rather than `0`.
  const length = request.contentLength === 0 ? "" : String(request.contentLength);

  return [
    request.method,
    ...leadingHeaders.map(standard),
    length,
    ...trailingHeaders.map((name) => (name === "date" ? "" : standard(name))),
    ...canonicalHeaders(fields),
    canonicalResource(request),
  ].join("\n");
}

export async function hmacSha256Base64(accountKey: string, data: string): Promise<string> {
  const key = await crypto.subtle.importKey(
    "raw",
    accountKeyBytes(accountKey),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const signature = new Uint8Array(await crypto.subtle.sign("HMAC", key, utf8.encode(data)));

  return btoa(String.fromCharCode(...signature));
}

function canonicalHeaders(fields: ReadonlyMap<string, string>): string[] {
  return [...fields]
    .filter(([name]) => name.startsWith(canonicalPrefix))
    .toSorted(([one], [other]) => compareHeaderNames(one, other))
    .map(([name, value]) => `${name}:${value.trim().replace(whitespaceRun, " ")}`);
}

/**
 * Spec 8.4: code point order, except that `_` sorts before the digits. That is where the
 * service places it, and it is the one place its order parts from code points among the
 * characters a header name here holds. A runtime's collation is never asked, because
 * `localeCompare` answers differently from one runtime and locale to the next.
 */
export function compareHeaderNames(one: string, other: string): number {
  const length = Math.min(one.length, other.length);

  for (let index = 0; index < length; index += 1) {
    const difference = weightOf(one.charCodeAt(index)) - weightOf(other.charCodeAt(index));

    if (difference !== 0) return difference;
  }

  return one.length - other.length;
}

const underscore = 0x5f;
const digitZero = 0x30;

function weightOf(code: number): number {
  return code === underscore ? digitZero - 0.5 : code;
}

/**
 * `/<account><path>`, then one line per query parameter: the name lower-cased, the values
 * of one name sorted and joined by commas, every name in code point order.
 */
function canonicalResource(request: Omit<SignableRequest, "date">): string {
  const values = new Map<string, string[]>();

  for (const [name, value] of request.query) {
    const folded = name.toLowerCase();

    values.set(folded, [...(values.get(folded) ?? []), value]);
  }

  const lines = [...values]
    .toSorted(([one], [other]) => (one < other ? -1 : one > other ? 1 : 0))
    .map(([name, held]) => `\n${name}:${held.toSorted().join(",")}`);

  return `/${request.account}${request.path}${lines.join("")}`;
}
