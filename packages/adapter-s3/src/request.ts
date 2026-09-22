import { errorCodeForStatus, isTransientStatus, type StorageError } from "@stowage/core";

import { encodePath, encodeQuery, type HeaderField, type QueryParameter } from "./canonical.ts";
import type { S3Configuration } from "./configuration.ts";
import { resolveCredentials } from "./credentials.ts";
import { sha256Hex } from "./hash.ts";
import { signRequest } from "./sign.ts";
import { inStorage, s3Error } from "./storage-error.ts";

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
}

const emptyBody: Uint8Array<ArrayBuffer> = new Uint8Array(0);

const service = "s3";

/**
 * One S3 request, answered by the response the provider sent or rejected with the
 * failure it reported. Spec 7.4 computes the payload hash once and signs every attempt
 * again; the repeat of spec 7.5 wraps this and is what turns one attempt into three.
 */
export async function send(configuration: S3Configuration, request: S3Request): Promise<Response> {
  const payloadHash = await sha256Hex(request.body ?? emptyBody);
  const response = await attempt(configuration, request, payloadHash);

  if (!response.ok) throw await failureOf(configuration, request, response);

  return response;
}

async function attempt(
  configuration: S3Configuration,
  request: S3Request,
  payloadHash: string,
): Promise<Response> {
  const path = pathOf(configuration, request.key);
  const query = request.query ?? [];
  const credentials = await resolveCredentials(configuration.credentials, {
    forceRefresh: false,
  }).catch((failure: unknown) => {
    throw inStorage(failure, configuration.bucket, request.operation, request.key);
  });
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
  const url = `${configuration.protocol}//${configuration.host}${encodePath(path)}${
    query.length === 0 ? "" : `?${encodeQuery(query)}`
  }`;

  try {
    return await fetch(url, {
      method: request.method,
      headers: signed.headers.map(([name, value]) => [name, value]),
      body: request.body,
      signal: request.signal,
    });
  } catch (failure) {
    throw transportFailure(configuration, request, failure);
  }
}

/**
 * Spec 7.1: the bucket is addressed virtual-hosted through the host, and path-style
 * through the first segment of the path. The key follows as it stands; `encodePath` is
 * what percent-encodes it, on the URL and in the signature alike.
 */
function pathOf(configuration: S3Configuration, key: string | undefined): string {
  const prefix = configuration.forcePathStyle
    ? `${configuration.basePath}/${configuration.bucket}`
    : configuration.basePath;

  if (key === undefined) return prefix === "" ? "/" : prefix;

  return `${prefix}/${key}`;
}

/**
 * Spec 4.10 maps the status where no provider code is recognized. The table of spec 7.9
 * and the XML body it reads the code out of arrive with the retry policy; until then a
 * failure carries the status, the request id and the one attempt it cost.
 */
async function failureOf(
  configuration: S3Configuration,
  request: S3Request,
  response: Response,
): Promise<StorageError> {
  // Nothing reads the body yet, and a body left unread holds the connection open.
  await response.body?.cancel();

  return s3Error(configuration.bucket, {
    code: errorCodeForStatus(response.status) ?? "ProviderError",
    message: `The provider answered ${response.status} to \`${request.method}\``,
    operation: request.operation,
    key: request.key,
    attempts: 1,
    status: response.status,
    requestId: response.headers.get("x-amz-request-id") ?? undefined,
    retryable: isTransientStatus(response.status),
  });
}

// Spec 4.10: an aborted signal produces the runtime's `AbortError` and never a
// `StorageError`, so the one failure `fetch` throws that is not a transport failure
// travels on untouched.
function transportFailure(
  configuration: S3Configuration,
  request: S3Request,
  failure: unknown,
): unknown {
  if (failure instanceof Error && failure.name === "AbortError") return failure;

  return s3Error(configuration.bucket, {
    code: "NetworkError",
    message: `The request received no response: ${String(failure)}`,
    operation: request.operation,
    key: request.key,
    attempts: 1,
    retryable: true,
    cause: failure,
  });
}
