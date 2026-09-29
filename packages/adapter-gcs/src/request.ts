import { errorCodeForStatus, isTransientStatus, type StorageError, withRetry } from "@stowage/core";

import type { GcsConfiguration } from "./configuration.ts";
import { resolveCredentials } from "./credentials.ts";
import { gcsError, inStorage } from "./storage-error.ts";

export type HeaderField = readonly [name: string, value: string];
export type QueryParameter = readonly [name: string, value: string];

export interface GcsRequest {
  readonly method: string;
  readonly operation: string;
  /** The key the request addresses, which a failure is told against. */
  readonly key?: string;
  /** Encoded, as the request line carries it: `objectPath` or `uploadPath`. */
  readonly path: string;
  readonly query?: readonly QueryParameter[];
  readonly headers?: readonly HeaderField[];
  readonly body?: Uint8Array<ArrayBuffer>;
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
  return await withRetry(async () => await attempt(configuration, request), {
    maxAttempts: configuration.maxAttempts,
    signal: request.signal,
  });
}

/**
 * One request under a token resolved for it alone, which is the attempt CONTEXT.md names
 * and what a repeat repeats (spec 9.3).
 */
async function attempt(configuration: GcsConfiguration, request: GcsRequest): Promise<Response> {
  const credentials = await resolveCredentials(configuration.credentials, {
    forceRefresh: false,
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
    throw transportFailure(configuration, request, failure);
  }

  if (response.ok) return response;

  throw await failureOf(configuration, request, response);
}

/** The path of the object's resource, and of its media download under `alt=media`. */
export function objectPath(configuration: GcsConfiguration, key: string): string {
  return `${bucketPath(configuration, "storage")}/o/${encodeSegment(key)}`;
}

/** The path an upload of an object is sent to. */
export function uploadPath(configuration: GcsConfiguration): string {
  return `${bucketPath(configuration, "upload/storage")}/o`;
}

function bucketPath(configuration: GcsConfiguration, api: string): string {
  const base = configuration.basePath.split("/").map(encodeSegment).join("/");

  return `${base}/${api}/v1/b/${encodeSegment(configuration.bucket)}`;
}

/**
 * Spec 9.4: the key is one path segment, its slashes encoded, so that `#`, `%`, `?`, `+`,
 * a space and everything above ASCII reach the provider as written. No `URL` is built
 * from it: the constructor folds a `..` segment away and decodes what it was handed.
 */
function encodeSegment(value: string): string {
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

  return `${configuration.origin}${request.path}${search}`;
}

/**
 * The status decides the code (spec 4.10), and the error document of the JSON API, where
 * the body is one, gives the message and the provider's reason.
 */
async function failureOf(
  configuration: GcsConfiguration,
  request: GcsRequest,
  response: Response,
): Promise<StorageError> {
  const document = await readErrorDocument(response);
  const message =
    document.message ?? `The provider answered ${response.status} to \`${request.method}\``;

  return gcsError(configuration.bucket, {
    code: errorCodeForStatus(response.status) ?? "ProviderError",
    message,
    operation: request.operation,
    key: request.key,
    attempts: 1,
    status: response.status,
    providerCode: document.reason,
    requestId: response.headers.get(requestIdHeader) ?? undefined,
    retryable: isTransientStatus(response.status),
  });
}

interface ErrorDocument {
  readonly message?: string;
  readonly reason?: string;
}

/**
 * `{ error: { message, errors: [{ reason }] } }`, read to the end, which is also what
 * releases the connection the next attempt needs. A body that is no such document leaves
 * both unset rather than failing on its way to reporting a failure.
 */
async function readErrorDocument(response: Response): Promise<ErrorDocument> {
  try {
    const parsed: unknown = JSON.parse(await response.text());
    const error = fieldOf(parsed, "error");
    const [first] = arrayOf(fieldOf(error, "errors"));

    return {
      message: stringOf(fieldOf(error, "message")),
      reason: stringOf(fieldOf(first, "reason")),
    };
  } catch (failure) {
    if (failure instanceof Error && failure.name === "AbortError") throw failure;

    return {};
  }
}

function fieldOf(value: unknown, name: string): unknown {
  return typeof value === "object" && value !== null ? Reflect.get(value, name) : undefined;
}

function arrayOf(value: unknown): readonly unknown[] {
  return Array.isArray(value) ? value : [];
}

function stringOf(value: unknown): string | undefined {
  return typeof value === "string" && value !== "" ? value : undefined;
}

// Spec 4.10: an aborted signal produces the runtime's `AbortError` and never a
// `StorageError`, so the one failure `fetch` throws that is not a transport failure
// travels on untouched.
function transportFailure(
  configuration: GcsConfiguration,
  request: GcsRequest,
  failure: unknown,
): unknown {
  if (failure instanceof Error && failure.name === "AbortError") return failure;

  return gcsError(configuration.bucket, {
    code: "NetworkError",
    message: `The request received no response: ${String(failure)}`,
    operation: request.operation,
    key: request.key,
    attempts: 1,
    retryable: true,
    cause: failure,
  });
}
