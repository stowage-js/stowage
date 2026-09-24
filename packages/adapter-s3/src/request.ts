import { isStorageError, isTransientStatus, type StorageError, withRetry } from "@stowage/core";

import { encodePath, encodeQuery, type HeaderField, type QueryParameter } from "./canonical.ts";
import type { S3Configuration } from "./configuration.ts";
import { resolveCredentials } from "./credentials.ts";
import { readErrorDocument, type S3ErrorDocument } from "./error-document.ts";
import { sha256Hex } from "./hash.ts";
import { readProviderFailure } from "./provider-code.ts";
import { signRequest } from "./sign.ts";
import { inStorage, s3Error, withAttemptsMade } from "./storage-error.ts";

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
 * loop of spec 7.5 lives in `@stowage/core`, as the one definition of the budget and the
 * curve that a third-party adapter reads too.
 */
export async function send(configuration: S3Configuration, request: S3Request): Promise<Response> {
  const payloadHash = await sha256Hex(request.body ?? emptyBody);
  let requestsSent = 0;

  try {
    return await withRetry(
      async () => {
        try {
          return await attemptWithRefresh(configuration, request, payloadHash);
        } catch (failure) {
          if (!isStorageError(failure)) throw failure;

          requestsSent += failure.attempts;

          if (request.repeatWithoutResponse === false && receivedNoResponse(failure)) {
            throw new Unrepeated(withAttemptsMade(failure, requestsSent));
          }

          throw failure;
        }
      },
      { maxAttempts: configuration.maxAttempts, signal: request.signal },
    );
  } catch (thrown) {
    if (thrown instanceof Unrepeated) throw thrown.failure;

    throw thrown;
  }
}

/**
 * A failure carried past `withRetry`, which repeats every `retryable` `StorageError` it
 * sees; the one that must not be repeated still reaches the caller as `retryable`,
 * because spec 4.10 has that flag state the condition and not what stowage did about it.
 */
class Unrepeated {
  readonly failure: StorageError;

  constructor(failure: StorageError) {
    this.failure = failure;
  }
}

function receivedNoResponse(failure: StorageError): boolean {
  return failure.code === "NetworkError" && failure.status === undefined;
}

/**
 * One attempt, which spec 7.3 has cost a second request where the provider answered
 * `Expired`: the credential is resolved again under `forceRefresh` and the request goes
 * out without a delay, because no wait makes a credential fresher. `retry: false` does
 * not switch that repeat off, so an attempt costs one request or two and an operation at
 * most six (ADR 0013).
 */
async function attemptWithRefresh(
  configuration: S3Configuration,
  request: S3Request,
  payloadHash: string,
): Promise<Response> {
  try {
    return await attemptOnce(configuration, request, payloadHash, false, 1);
  } catch (failure) {
    if (!isStorageError(failure) || failure.code !== "Expired") throw failure;

    return await attemptOnce(configuration, request, payloadHash, true, 2);
  }
}

/** One signed request, which is the attempt CONTEXT.md names and what a repeat repeats. */
async function attemptOnce(
  configuration: S3Configuration,
  request: S3Request,
  payloadHash: string,
  forceRefresh: boolean,
  attempts: number,
): Promise<Response> {
  const path = pathOf(configuration, request.key);
  const query = request.query ?? [];
  const credentials = await resolveCredentials(configuration.credentials, { forceRefresh }).catch(
    (failure: unknown) => {
      throw inStorage(failure, configuration.bucket, request.operation, request.key);
    },
  );
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
  const url = urlOf(configuration, path, query);
  let response: Response;

  try {
    response = await fetch(url, {
      method: request.method,
      headers: [...signed.headers, identityEncoding].map(([name, value]) => [name, value]),
      body: request.body,
      signal: request.signal,
    });
  } catch (failure) {
    throw transportFailure(configuration, request, failure, attempts);
  }

  if (response.ok) return response;

  throw await failureOf(configuration, request, response, attempts);
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
 * spec 4.10 decides where it does not, and the status alone decides whether the condition
 * is transient. `status`, `providerCode`, `requestId` and the provider's message travel
 * along, which is what makes a failure traceable at the provider.
 */
async function failureOf(
  configuration: S3Configuration,
  request: S3Request,
  response: Response,
  attempts: number,
): Promise<StorageError> {
  const document = await readFailure(request, response);
  const failure = readProviderFailure({
    status: response.status,
    operation: request.operation,
    method: request.method,
    key: request.key,
    hasContinuationToken: request.query?.some(([name]) => name === "continuation-token"),
    providerCode: document.code,
    providerMessage: document.message,
    bucketRegion: response.headers.get("x-amz-bucket-region") ?? undefined,
  });

  return s3Error(configuration.bucket, {
    code: failure.code,
    message: failure.message,
    operation: request.operation,
    key: request.key,
    attempts,
    status: response.status,
    providerCode: document.code,
    requestId: response.headers.get("x-amz-request-id") ?? undefined,
    retryable: isTransientStatus(response.status),
  });
}

/**
 * Spec 7.9: `HEAD` carries no body, so `stat` and `exists` report the status alone. Every
 * other failed request is answered with the provider's error document, and reading it to
 * the end is also what releases the connection the next attempt needs.
 */
async function readFailure(request: S3Request, response: Response): Promise<S3ErrorDocument> {
  if (request.method === "HEAD") {
    await response.body?.cancel();

    return {};
  }

  try {
    return readErrorDocument(await response.text());
  } catch {
    // A body that broke on the way says nothing the status has not said already.
    return {};
  }
}

// Spec 4.10: an aborted signal produces the runtime's `AbortError` and never a
// `StorageError`, so the one failure `fetch` throws that is not a transport failure
// travels on untouched.
function transportFailure(
  configuration: S3Configuration,
  request: S3Request,
  failure: unknown,
  attempts: number,
): unknown {
  if (failure instanceof Error && failure.name === "AbortError") return failure;

  return s3Error(configuration.bucket, {
    code: "NetworkError",
    message: `The request received no response: ${String(failure)}`,
    operation: request.operation,
    key: request.key,
    attempts,
    retryable: true,
    cause: failure,
  });
}
