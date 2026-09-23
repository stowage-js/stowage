import {
  type CanonicalHeaders,
  canonicalHeaders,
  encodePath,
  encodeQuery,
  type HeaderField,
  type QueryParameter,
} from "./canonical.ts";
import type { S3Credentials } from "./credentials.ts";
import { hex, hmacSha256, sha256Hex } from "./hash.ts";

export const signingAlgorithm = "AWS4-HMAC-SHA256";

export interface SignableRequest {
  readonly method: string;
  readonly host: string;
  /** Written as the request carries it; `encodePath` is what percent-encodes it. */
  readonly path: string;
  readonly query: readonly QueryParameter[];
  /** What the request carries beside `host`, `x-amz-date` and the session token. */
  readonly headers: readonly HeaderField[];
  readonly payloadHash: string;
  readonly credentials: S3Credentials;
  readonly region: string;
  /** `"s3"` for every request the adapter sends; the published vectors sign `"service"`. */
  readonly service: string;
  readonly date: Date;
}

export interface SignedRequest {
  /** What to send. `host` is signed and left out: `fetch` sets it from the URL. */
  readonly headers: readonly HeaderField[];
  /**
   * The two strings the signature is built out of. Nothing sends them; the published
   * test vectors state both, and a vector that fails on one of them says which of the
   * five canonical parts went wrong rather than that 64 hex characters differ.
   */
  readonly canonicalRequest: string;
  readonly stringToSign: string;
  readonly signature: string;
}

export async function signRequest(request: SignableRequest): Promise<SignedRequest> {
  const amzDate = amzDateOf(request.date);
  const scope = scopeOf(request, amzDate);
  const toSend: readonly HeaderField[] = [
    ...request.headers,
    ["x-amz-date", amzDate],
    ...sessionTokenField(request.credentials),
  ];
  const canonical = canonicalHeaders([...toSend, ["host", request.host]]);
  const signed = await signCanonical(request, {
    query: request.query,
    canonical,
    payloadHash: request.payloadHash,
    amzDate,
    scope,
  });
  const authorization =
    `${signingAlgorithm} Credential=${request.credentials.accessKeyId}/${scope}, ` +
    `SignedHeaders=${canonical.names}, Signature=${signed.signature}`;

  return { headers: [...toSend, ["authorization", authorization]], ...signed };
}

/**
 * Spec 7.4 and ADR 0011: the payload hash a presigned URL signs, which excludes the body
 * from the signature because the signer never sees it. It is written here and nowhere
 * else, so a request the adapter sends itself has no way to carry it.
 */
const unsignedPayload = "UNSIGNED-PAYLOAD";

export interface PresignableRequest {
  readonly method: string;
  readonly host: string;
  /** Written as the URL carries it; `encodePath` is what percent-encodes it. */
  readonly path: string;
  /** What the URL carries beside the parameters the signature adds. */
  readonly query: readonly QueryParameter[];
  /** What whoever calls the URL has to send exactly, beside `host`. */
  readonly headers: readonly HeaderField[];
  readonly credentials: S3Credentials;
  readonly region: string;
  readonly service: string;
  readonly date: Date;
  /** Seconds, which spec 7.10 has the caller check against 1 to 604800 first. */
  readonly expiresIn: number;
}

export interface PresignedRequest {
  /** The whole query of the URL, the signature last. */
  readonly query: readonly QueryParameter[];
  readonly canonicalRequest: string;
  readonly stringToSign: string;
}

/**
 * SigV4 query signing: the authorization travels in the query rather than in headers, so
 * that a client holding no credential can send the request. The headers it binds are
 * signed and not handed back, because whoever calls the URL sends them.
 */
export async function presignRequest(request: PresignableRequest): Promise<PresignedRequest> {
  const amzDate = amzDateOf(request.date);
  const scope = scopeOf(request, amzDate);
  const canonical = canonicalHeaders([...request.headers, ["host", request.host]]);
  const query: readonly QueryParameter[] = [
    ...request.query,
    ["X-Amz-Algorithm", signingAlgorithm],
    ["X-Amz-Credential", `${request.credentials.accessKeyId}/${scope}`],
    ["X-Amz-Date", amzDate],
    ["X-Amz-Expires", String(request.expiresIn)],
    ["X-Amz-SignedHeaders", canonical.names],
    ...sessionTokenParameter(request.credentials),
  ];
  const signed = await signCanonical(request, {
    query,
    canonical,
    payloadHash: unsignedPayload,
    amzDate,
    scope,
  });

  return {
    query: [...query, ["X-Amz-Signature", signed.signature]],
    canonicalRequest: signed.canonicalRequest,
    stringToSign: signed.stringToSign,
  };
}

interface SigningScope {
  readonly method: string;
  readonly path: string;
  readonly credentials: S3Credentials;
  readonly region: string;
  readonly service: string;
}

interface CanonicalInput {
  readonly query: readonly QueryParameter[];
  readonly canonical: CanonicalHeaders;
  readonly payloadHash: string;
  readonly amzDate: string;
  readonly scope: string;
}

interface Signature {
  readonly canonicalRequest: string;
  readonly stringToSign: string;
  readonly signature: string;
}

/** The part both forms share: the canonical request, the string to sign and its HMAC. */
async function signCanonical(request: SigningScope, input: CanonicalInput): Promise<Signature> {
  const canonicalRequest = [
    request.method,
    encodePath(request.path),
    encodeQuery(input.query),
    input.canonical.lines,
    input.canonical.names,
    input.payloadHash,
  ].join("\n");
  const stringToSign = [
    signingAlgorithm,
    input.amzDate,
    input.scope,
    await sha256Hex(canonicalRequest),
  ].join("\n");
  const signature = hex(
    await hmacSha256(await signingKey(request, input.amzDate.slice(0, 8)), stringToSign),
  );

  return { canonicalRequest, stringToSign, signature };
}

function scopeOf(request: SigningScope, amzDate: string): string {
  return `${amzDate.slice(0, 8)}/${request.region}/${request.service}/aws4_request`;
}

/** `20150830T123600Z`, which is what `x-amz-date` and the credential scope are written in. */
export function amzDateOf(date: Date): string {
  return `${date.toISOString().replaceAll(/[.:-]/gu, "").slice(0, 15)}Z`;
}

function sessionTokenField(credentials: S3Credentials): readonly HeaderField[] {
  if (credentials.sessionToken === undefined) return [];

  return [["x-amz-security-token", credentials.sessionToken]];
}

function sessionTokenParameter(credentials: S3Credentials): readonly QueryParameter[] {
  if (credentials.sessionToken === undefined) return [];

  return [["X-Amz-Security-Token", credentials.sessionToken]];
}

async function signingKey(request: SigningScope, dateStamp: string): Promise<ArrayBuffer> {
  const utf8 = new TextEncoder();
  const date = await hmacSha256(
    utf8.encode(`AWS4${request.credentials.secretAccessKey}`),
    dateStamp,
  );
  const region = await hmacSha256(date, request.region);
  const service = await hmacSha256(region, request.service);

  return await hmacSha256(service, "aws4_request");
}
