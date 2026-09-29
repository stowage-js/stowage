import { encodeSegment, type HeaderField, type QueryParameter } from "./request.ts";

export type Sign = (stringToSign: Uint8Array<ArrayBuffer>) => Promise<Uint8Array>;

/** One operation on one path, as a V4 signed URL on the XML API grants it (spec 9.9). */
export interface UrlToSign {
  readonly method: string;
  /** Scheme and authority, which the URL starts with and the `host` header is signed from. */
  readonly origin: string;
  /** The path as it stands before encoding, whose segments are encoded one by one. */
  readonly path: string;
  /** Headers the request must carry as signed, beside `host`. */
  readonly headers: readonly HeaderField[];
  /** Query parameters the URL carries beside the ones of the signature. */
  readonly query: readonly QueryParameter[];
  readonly serviceAccount: string;
  readonly signedAt: Date;
  readonly expiresIn: number;
}

const algorithm = "GOOG4-RSA-SHA256";

/** ADR 0035: the location Google's Node signer puts in the scope, and every vector with it. */
const scopeLocation = "auto";

const collapsibleWhitespace = /[ \t]+/gu;

const utf8 = new TextEncoder();

/**
 * The URL with its `X-Goog-Signature`, after Google's canonical request for a V4 signed URL.
 * The `host` header is signed as the origin's host name: Google's vectors sign `localhost` for
 * a URL on `localhost:8080`, and the public service has no port to lose.
 */
export async function signUrl(request: UrlToSign, sign: Sign): Promise<string> {
  const timestamp = timestampOf(request.signedAt);
  const scope = `${timestamp.slice(0, 8)}/${scopeLocation}/storage/goog4_request`;
  const headers = canonicalHeaders([
    ["host", new URL(request.origin).hostname],
    ...request.headers,
  ]);
  const signedHeaders = headers.map(([name]) => name).join(";");
  const query = canonicalQuery([
    ["X-Goog-Algorithm", algorithm],
    ["X-Goog-Credential", `${request.serviceAccount}/${scope}`],
    ["X-Goog-Date", timestamp],
    ["X-Goog-Expires", String(request.expiresIn)],
    ["X-Goog-SignedHeaders", signedHeaders],
    ...request.query,
  ]);
  const path = request.path.split("/").map(encodeSegment).join("/");
  const canonicalRequest = [
    request.method,
    path,
    query,
    ...headers.map(([name, value]) => `${name}:${value}`),
    "",
    signedHeaders,
    "UNSIGNED-PAYLOAD",
  ].join("\n");
  const stringToSign = [algorithm, timestamp, scope, await sha256Hex(canonicalRequest)].join("\n");
  const signature = hex(await sign(utf8.encode(stringToSign)));

  return `${request.origin}${path}?${query}&X-Goog-Signature=${signature}`;
}

function canonicalHeaders(headers: readonly HeaderField[]): readonly HeaderField[] {
  return headers
    .map(([name, value]): HeaderField => [
      name.toLowerCase(),
      value.trim().replace(collapsibleWhitespace, " "),
    ])
    .toSorted(([one], [other]) => compare(one, other));
}

function canonicalQuery(query: readonly QueryParameter[]): string {
  return query
    .map(([name, value]) => [encodeSegment(name), encodeSegment(value)] as const)
    .toSorted(([oneName, oneValue], [otherName, otherValue]) =>
      oneName === otherName ? compare(oneValue, otherValue) : compare(oneName, otherName),
    )
    .map(([name, value]) => `${name}=${value}`)
    .join("&");
}

/** By code unit, which is byte order for what the encoding leaves: ASCII alone. */
function compare(one: string, other: string): number {
  if (one === other) return 0;

  return one < other ? -1 : 1;
}

/** `YYYYMMDD'T'HHMMSS'Z'`, the moment of signing in UTC without separators. */
function timestampOf(date: Date): string {
  return date
    .toISOString()
    .replace(/[-:]/gu, "")
    .replace(/\.\d{3}/u, "");
}

async function sha256Hex(text: string): Promise<string> {
  return hex(new Uint8Array(await crypto.subtle.digest("SHA-256", utf8.encode(text))));
}

function hex(bytes: Uint8Array): string {
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
}
