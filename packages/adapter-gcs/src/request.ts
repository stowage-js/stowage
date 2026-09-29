import { isTransientStatus, type Resolvable, type StorageError, withRetry } from "@stowage/core";

import type { GcsConfiguration } from "./configuration.ts";
import { type GcsCredentials, resolveCredentials } from "./credentials.ts";
import {
  type ErrorBody,
  isRefusedToken,
  readErrorBody,
  readProviderFailure,
} from "./provider-code.ts";
import { gcsError, inStorage } from "./storage-error.ts";

export type HeaderField = readonly [name: string, value: string];
export type QueryParameter = readonly [name: string, value: string];

export interface GcsRequest {
  readonly method: string;
  readonly operation: string;
  /** Scheme and host where the request goes elsewhere than the endpoint: `signBlob` to IAM. */
  readonly origin?: string;
  /** The credential the request carries where it is not the storage's: the signer's. */
  readonly credentials?: Resolvable<GcsCredentials>;
  /** The key the request addresses, which a failure is told against. */
  readonly key?: string;
  /** Encoded, as the request line carries it: `objectPath` or `uploadPath`. */
  readonly path: string;
  readonly query?: readonly QueryParameter[];
  readonly headers?: readonly HeaderField[];
  readonly body?: Uint8Array<ArrayBuffer>;
  /** Set on the media download, whose `404` is read by its status (spec 9.8). */
  readonly media?: boolean;
  /** Set on a listing sent with the caller's cursor, whose `invalid` refuses it (spec 9.8). */
  readonly carriesCursor?: boolean;
  readonly signal?: AbortSignal;
}

/** Spec 9.8: the identifier Google asks for when a request is reported to its support. */
export const requestIdHeader = "x-guploader-uploadid";

/** What `encodeURIComponent` leaves alone and RFC 3986 counts as reserved. */
const reservedByEncodeUriComponent = /[!'()*]/gu;

/**
 * One request to the JSON API, answered by the response the provider sent or rejected with
 * its failure. The loop of spec 9.5 lives in `@stowage/core`, as the one definition of the
 * budget and the curve.
 */
export async function send(
  configuration: GcsConfiguration,
  request: GcsRequest,
): Promise<Response> {
  return await withRetry(async () => await attempt(configuration, request, false), {
    maxAttempts: configuration.maxAttempts,
    signal: request.signal,
  });
}

/**
 * One request under a token resolved for it alone, which is the attempt CONTEXT.md names
 * and what a repeat repeats.
 *
 * Spec 9.3 has an attempt cost a second request where GCS refused the token as
 * `invalid_token`: the credential is resolved again under `forceRefresh` and the request
 * goes out without a delay, because no wait makes a token fresher. `retry: false` does not
 * switch that repeat off, so an attempt costs one request or two (spec 9.5).
 */
async function attempt(
  configuration: GcsConfiguration,
  request: GcsRequest,
  forceRefresh: boolean,
): Promise<Response> {
  const attempts = forceRefresh ? 2 : 1;
  const credentials = await resolveCredentials(request.credentials ?? configuration.credentials, {
    forceRefresh,
  }).catch((failure: unknown) => {
    throw inStorage(failure, configuration.bucket, request.operation, request.key);
  });
  let response: Response;

  try {
    response = await fetch(urlOf(configuration, request), {
      method: request.method,
      headers: [
        ...(request.headers ?? []),
        ["authorization", `Bearer ${credentials.accessToken}`],
      ].map(([name, value]) => [name, value]),
      body: request.body,
      signal: request.signal,
    });
  } catch (failure) {
    throw transportFailure(configuration, request, failure, attempts);
  }

  if (response.ok) return response;

  if (!forceRefresh && isRefusedToken(response)) {
    await response.body?.cancel().catch(() => {});

    return await attempt(configuration, request, true);
  }

  throw await failureOf(configuration, request, response, {
    attempts,
    underRefreshedToken: forceRefresh,
  });
}

/** The path of the object's resource, and of its media download under `alt=media`. */
export function objectPath(configuration: GcsConfiguration, key: string): string {
  return `${bucketPath(configuration, "storage")}/o/${encodeSegment(key)}`;
}

/** The path of the bucket's objects, which `objects.list` lists. */
export function listPath(configuration: GcsConfiguration): string {
  return `${bucketPath(configuration, "storage")}/o`;
}

export function uploadPath(configuration: GcsConfiguration): string {
  return `${bucketPath(configuration, "upload/storage")}/o`;
}

/** The path of the batch endpoint, which carries the deletes of `delete` (spec 9.4). */
export function batchPath(configuration: GcsConfiguration): string {
  return `${encodedBasePath(configuration)}/batch/storage/v1`;
}

function bucketPath(configuration: GcsConfiguration, api: string): string {
  return `${encodedBasePath(configuration)}/${api}/v1/b/${encodeSegment(configuration.bucket)}`;
}

function encodedBasePath(configuration: GcsConfiguration): string {
  return configuration.basePath.split("/").map(encodeSegment).join("/");
}

/**
 * Spec 9.4: the key is one path segment, its slashes encoded, so that `#`, `%`, `?`, `+`,
 * a space and everything above ASCII reach the provider as written. No `URL` is built
 * from it: the constructor folds a `..` segment away and decodes what it was handed.
 */
export function encodeSegment(value: string): string {
  return encodeURIComponent(value).replace(
    reservedByEncodeUriComponent,
    (character) => `%${character.charCodeAt(0).toString(16).toUpperCase()}`,
  );
}

function urlOf(configuration: GcsConfiguration, request: GcsRequest): string {
  const query = request.query ?? [];
  const search =
    query.length === 0
      ? ""
      : `?${query.map(([name, value]) => `${encodeSegment(name)}=${encodeSegment(value)}`).join("&")}`;

  return `${request.origin ?? configuration.origin}${request.path}${search}`;
}

/** The provider code and the message are read out of the body, where it carries them (spec 9.8). */
async function failureOf(
  configuration: GcsConfiguration,
  request: GcsRequest,
  response: Response,
  made: { readonly attempts: number; readonly underRefreshedToken: boolean },
): Promise<StorageError> {
  const body = await readBody(response);
  const failure = readProviderFailure({
    status: response.status,
    method: request.method,
    providerCode: body.providerCode,
    providerMessage: body.message,
    media: request.media === true,
    carriesCursor: request.carriesCursor === true,
    underRefreshedToken: made.underRefreshedToken,
    headers: response.headers,
  });

  return gcsError(configuration.bucket, {
    code: failure.code,
    message: failure.message,
    operation: request.operation,
    key: failure.ofBucket === true ? undefined : request.key,
    attempts: made.attempts,
    status: response.status,
    providerCode: body.providerCode,
    requestId: response.headers.get(requestIdHeader) ?? undefined,
    retryable: isTransientStatus(response.status),
  });
}

/**
 * The body read to the end, which is also what releases the connection the next attempt
 * needs. A body that breaks on the way leaves provider code and message unset rather than
 * failing on its way to reporting a failure.
 */
async function readBody(response: Response): Promise<ErrorBody> {
  try {
    return readErrorBody(await response.text());
  } catch (failure) {
    if (failure instanceof Error && failure.name === "AbortError") throw failure;

    return {};
  }
}

// Spec 4.10: an aborted signal produces the runtime's `AbortError` and never a
// `StorageError`, so the one failure `fetch` throws that is not a transport failure
// travels on untouched.
function transportFailure(
  configuration: GcsConfiguration,
  request: GcsRequest,
  failure: unknown,
  attempts: number,
): unknown {
  if (failure instanceof Error && failure.name === "AbortError") return failure;

  return gcsError(configuration.bucket, {
    code: "NetworkError",
    message: `The request received no response: ${String(failure)}`,
    operation: request.operation,
    key: request.key,
    attempts,
    retryable: true,
    cause: failure,
  });
}
