import {
  type FailureReading,
  type PreparedAttempt,
  type RefusedAnswer,
  sendRequest,
} from "@stowage/core";

import { encodePath, encodeQuery, type HeaderField, type QueryParameter } from "./canonical.ts";
import type { S3Configuration } from "./configuration.ts";
import { resolveCredentials } from "./credentials.ts";
import { readErrorDocument } from "./error-document.ts";
import { sha256Hex } from "./hash.ts";
import { isRefusedTemporaryCredential, readProviderFailure } from "./provider-code.ts";
import { signRequest } from "./sign.ts";

export interface S3Request {
  readonly method: string;
  readonly operation: string;
  /** The key the request addresses, absent for a request about the bucket itself. */
  readonly key?: string;
  readonly query?: readonly QueryParameter[];
  readonly headers?: readonly HeaderField[];
  /** Held whole, because signing hashes it and a repeat sends it again (ADR 0009). */
  readonly body?: Uint8Array<ArrayBuffer>;
  readonly signal?: AbortSignal;
  /**
   * `false` for a request whose effect may have happened although no response arrived,
   * which spec 7.5 names for `CompleteMultipartUpload` alone. A status is repeated as
   * for any other request: the provider answered, so it did not commit.
   */
  readonly repeatWithoutResponse?: boolean;
}

const emptyBody: Uint8Array<ArrayBuffer> = new Uint8Array(0);

/**
 * Spec 4.4 reads `size` off `Content-Length`, and a provider that compresses on the offer
 * `fetch` makes of its own on Node, Bun and Deno drops that header: R2 does for JSON and
 * text. It is sent unsigned, because it concerns the transfer rather than what the
 * provider acts on, and a hop that rewrites it would otherwise break the signature.
 */
const identityEncoding: HeaderField = ["accept-encoding", "identity"];

const service = "s3";

/**
 * One S3 request, answered by the response the provider sent or rejected with the failure
 * it reported. Spec 7.4 computes the payload hash once and signs every attempt again; the
 * attempts of spec 7.5 and the refresh of spec 7.3 live in `@stowage/core`
 * (ADR 0057).
 */
export async function send(configuration: S3Configuration, request: S3Request): Promise<Response> {
  const payloadHash = await sha256Hex(request.body ?? emptyBody);

  return await sendRequest({
    provider: "s3",
    bucket: configuration.bucket,
    operation: request.operation,
    key: request.key,
    method: request.method,
    maxAttempts: configuration.maxAttempts,
    signal: request.signal,
    unanswered: request.repeatWithoutResponse === false ? "stop" : "repeat",
    prepare: async ({ forceRefresh }) =>
      await prepare(configuration, request, payloadHash, forceRefresh),
    readFailure: (answer) => readFailure(request, answer),
  });
}

/**
 * One signed request, which is the attempt CONTEXT.md names and what a repeat repeats.
 * Spec 7.3 refreshes after `Expired` whatever the credential, since a resolver may hand
 * back a key pair as well as a session token.
 */
async function prepare(
  configuration: S3Configuration,
  request: S3Request,
  payloadHash: string,
  forceRefresh: boolean,
): Promise<PreparedAttempt> {
  const path = pathOf(configuration, request.key);
  const query = request.query ?? [];
  const credentials = await resolveCredentials(configuration.credentials, { forceRefresh });
  const signed = await signRequest({
    method: request.method,
    host: configuration.host,
    path,
    query,
    // Spec 7.4: every request carries the hash over the body it sends, signed with it.
    headers: [...(request.headers ?? []), ["x-amz-content-sha256", payloadHash]],
    payloadHash,
    credentials,
    region: configuration.region,
    service,
    date: new Date(),
  });

  return {
    url: urlOf(configuration, path, query),
    headers: [...signed.headers, identityEncoding],
    body: request.body,
    refreshable: true,
  };
}

/**
 * Spec 7.1: the bucket is addressed virtual-hosted through the host, and path-style
 * through the first segment of the path. The key follows as it stands; `encodePath` is
 * what percent-encodes it, on the URL and in the signature alike.
 */
export function pathOf(configuration: S3Configuration, key: string | undefined): string {
  const prefix = configuration.forcePathStyle
    ? `${configuration.basePath}/${configuration.bucket}`
    : configuration.basePath;

  if (key === undefined) return prefix === "" ? "/" : prefix;

  return `${prefix}/${key}`;
}

/**
 * The URL a request is sent to, its path and query encoded as SigV4 signs them: the
 * provider rebuilds the canonical request from what the URL carries, so the two may not
 * differ by a single escape.
 */
export function urlOf(
  configuration: S3Configuration,
  path: string,
  query: readonly QueryParameter[],
): string {
  const search = query.length === 0 ? "" : `?${encodeQuery(query)}`;

  return `${configuration.protocol}//${configuration.host}${encodePath(path)}${search}`;
}

/**
 * Spec 7.9: the provider's own code decides where the table recognizes one, the status of
 * spec 4.10 decides where it does not, and alone where no error document arrived, as for a
 * `HEAD`. `providerCode`, `requestId` and the provider's message travel along, which is
 * what makes a failure traceable at the provider.
 */
function readFailure(request: S3Request, answer: RefusedAnswer): FailureReading {
  const document = answer.body === undefined ? {} : readErrorDocument(answer.body);
  const underSessionToken = carriedSessionToken(answer);
  const failure = readProviderFailure({
    status: answer.status,
    operation: request.operation,
    method: request.method,
    key: request.key,
    hasContinuationToken: request.query?.some(([name]) => name === "continuation-token"),
    providerCode: document.code,
    providerMessage: document.message,
    bucketRegion: answer.headers.get("x-amz-bucket-region") ?? undefined,
    underSessionToken,
    underRefreshedCredential: answer.refreshed,
  });

  return {
    code: failure.code,
    message: failure.message,
    // Spec 4.10: an unset `key` is what tells a missing bucket from a missing object, which
    // share the code `NotFound` (ADR 0043).
    key: document.code === "NoSuchBucket" ? undefined : request.key,
    providerCode: document.code,
    requestId: answer.headers.get("x-amz-request-id") ?? undefined,
    refusedCredential:
      failure.code === "Expired" ||
      isRefusedTemporaryCredential({ providerCode: document.code, underSessionToken }),
  };
}

/**
 * ADR 0065: R2 answers a temporary credential past its `exp` as it answers a credential
 * that is wrong, and the session token is the one sign that the credential refused may
 * have expired.
 */
function carriedSessionToken(answer: RefusedAnswer): boolean {
  return answer.sentHeaders.some(([name]) => name === "x-amz-security-token");
}
