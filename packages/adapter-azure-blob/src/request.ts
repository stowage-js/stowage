import { parseXml, type StorageError, withRetry } from "@stowage/core";

import type { AzureBlobConfiguration } from "./configuration.ts";
import { type AzureBlobCredentials, resolveCredentials } from "./credentials.ts";
import { isRefusedToken, providerError } from "./provider-code.ts";
import {
  type HeaderField,
  type QueryParameter,
  type SignableRequest,
  signSharedKey,
} from "./sign.ts";
import { azureBlobError, inStorage } from "./storage-error.ts";

export interface AzureBlobRequest {
  readonly method: string;
  readonly operation: string;
  /** The key the request addresses, absent for a request about the container itself. */
  readonly key?: string;
  readonly query?: readonly QueryParameter[];
  readonly headers?: RequestHeaders;
  readonly body?: RequestBody;
  /** The key a `Put Blob From URL` copies from, which spec 8.8 tells a failure of the source by. */
  readonly copySource?: string;
  readonly signal?: AbortSignal;
}

/**
 * Headers that authorize another request than this one, such as the source of a copy, are
 * built for each attempt from the credential that attempt resolved, as a body is.
 */
export type RequestHeaders =
  | readonly HeaderField[]
  | ((credentials: AzureBlobCredentials) => Promise<readonly HeaderField[]>);

/**
 * Held whole: Azure refuses a chunked `Put Blob`, and Shared Key signs the length. A body
 * that authorizes requests of its own inside it is built for each attempt from the
 * credential that attempt resolved, so a repeat under `forceRefresh` renews them too.
 */
export type RequestBody =
  | Uint8Array<ArrayBuffer>
  | ((credentials: AzureBlobCredentials) => Promise<Uint8Array<ArrayBuffer>>);

/** Spec 8.4: the one version every request is sent under. */
export const serviceVersion = "2026-04-06";

/**
 * Spec 4.4 reads `size` off `Content-Length`, which a response compressed on the offer
 * `fetch` makes of its own would drop. It is sent unsigned, as Shared Key signs no header
 * outside its twelve and `x-ms-`.
 */
const identityEncoding: HeaderField = ["accept-encoding", "identity"];

/** What `encodeURIComponent` leaves alone and RFC 3986 counts as reserved. */
const reservedByEncodeUriComponent = /[!'()*]/gu;

/**
 * One Azure request, answered by the response the provider sent or rejected with its
 * failure. The loop of spec 8.5 lives in `@stowage/core`, as the one definition of the
 * budget and the curve that a third-party adapter reads too.
 */
export async function send(
  configuration: AzureBlobConfiguration,
  request: AzureBlobRequest,
): Promise<Response> {
  return await withRetry(async () => await attempt(configuration, request, false), {
    maxAttempts: configuration.maxAttempts,
    signal: request.signal,
  });
}

/**
 * One authorized request, which is the attempt CONTEXT.md names and what a repeat
 * repeats: the credential is resolved and the request dated and signed anew.
 *
 * Spec 8.3 has an attempt cost a second request where the provider refused an access
 * token: the credential is resolved again under `forceRefresh` and the request goes out
 * without a delay, because no wait makes a token fresher. `retry: false` does not switch
 * that repeat off, so an attempt costs one request or two and an operation at most six
 * (spec 8.5).
 */
async function attempt(
  configuration: AzureBlobConfiguration,
  request: AzureBlobRequest,
  forceRefresh: boolean,
): Promise<Response> {
  const attempts = forceRefresh ? 2 : 1;
  const path = requestPath(configuration, request.key);
  const query = request.query ?? [];
  const credentials = await resolveCredentials(configuration.credentials, {
    forceRefresh,
  }).catch((failure: unknown) => {
    throw inStorage(failure, configuration.container, request.operation, request.key);
  });
  const underAccessToken = "accessToken" in credentials;
  const body = typeof request.body === "function" ? await request.body(credentials) : request.body;
  const requested =
    typeof request.headers === "function" ? await request.headers(credentials) : request.headers;
  const headers = await authorize(
    configuration,
    { method: request.method, path, query, headers: requested ?? [] },
    body,
    credentials,
  );
  let response: Response;

  try {
    response = await fetch(urlOf(configuration, path, query), {
      method: request.method,
      headers: [...headers, identityEncoding].map(([name, value]) => [name, value]),
      body,
      signal: request.signal,
    });
  } catch (failure) {
    throw transportFailure(configuration, request, failure, attempts);
  }

  if (response.ok) return response;

  const answer = {
    status: response.status,
    providerCode: response.headers.get("x-ms-error-code") ?? undefined,
  };

  if (underAccessToken && !forceRefresh && isRefusedToken(answer)) {
    await response.body?.cancel();

    return await attempt(configuration, request, true);
  }

  throw await failureOf(configuration, request, response, {
    attempts,
    underRefreshedToken: underAccessToken && forceRefresh,
  });
}

async function authorize(
  configuration: AzureBlobConfiguration,
  request: Omit<SignableRequest, "account" | "contentLength">,
  body: Uint8Array | undefined,
  credentials: AzureBlobCredentials,
): Promise<readonly HeaderField[]> {
  // Shared Key needs a date to sign, and `fetch` forbids setting `Date`. Azure lists the
  // date among what every authorized request carries, so the bearer sends it too.
  return await authorizeHeaders(
    configuration,
    {
      ...request,
      headers: [
        ...request.headers,
        ["x-ms-version", serviceVersion],
        ["x-ms-date", new Date().toUTCString()],
      ],
      contentLength: body?.byteLength ?? 0,
    },
    credentials,
  );
}

/**
 * The headers a request carries under the credential, `authorization` added: a request
 * the adapter sends, or one it carries inside the body of another. Spec 8.3 and 8.4: the
 * field the resolver answered decides the scheme of this request alone, so a resolver may
 * move from one to the other between two calls.
 */
export async function authorizeHeaders(
  configuration: AzureBlobConfiguration,
  request: Omit<SignableRequest, "account">,
  credentials: AzureBlobCredentials,
): Promise<readonly HeaderField[]> {
  if ("accessToken" in credentials) {
    return [...request.headers, ["authorization", `Bearer ${credentials.accessToken}`]];
  }

  const signed = await signSharedKey(
    { ...request, account: configuration.account },
    credentials.accountKey,
  );

  return signed.headers;
}

/** The path a request to the key travels to, or to the container where there is none. */
export function requestPath(configuration: AzureBlobConfiguration, key?: string): string {
  return encodePath(pathOf(configuration, key));
}

/** The endpoint's path, the container and the key, as they stand and not yet encoded. */
function pathOf(configuration: AzureBlobConfiguration, key: string | undefined): string {
  const container = `${configuration.basePath}/${configuration.container}`;

  return key === undefined ? container : `${container}/${key}`;
}

/**
 * Spec 8.4: the path percent-encoded segment by segment, so that a slash stays a slash and
 * `#`, `%`, `?`, `+`, a space and everything above ASCII travel encoded. No `URL` is built
 * from it: the constructor folds a `..` segment away and decodes what it was handed, and
 * Shared Key signs the path exactly as the request line carries it.
 */
function encodePath(path: string): string {
  return path.split("/").map(encodeRfc3986).join("/");
}

function encodeRfc3986(value: string): string {
  return encodeURIComponent(value).replace(
    reservedByEncodeUriComponent,
    (character) => `%${character.charCodeAt(0).toString(16).toUpperCase()}`,
  );
}

/** The URL of the key, as another request names it: the source of a copy. */
export function blobUrl(
  configuration: AzureBlobConfiguration,
  key: string,
  query: readonly QueryParameter[],
): string {
  return urlOf(configuration, requestPath(configuration, key), query);
}

function urlOf(
  configuration: AzureBlobConfiguration,
  path: string,
  query: readonly QueryParameter[],
): string {
  const search =
    query.length === 0
      ? ""
      : `?${query.map(([name, value]) => `${encodeRfc3986(name)}=${encodeRfc3986(value)}`).join("&")}`;

  return `${configuration.protocol}//${configuration.host}${path}${search}`;
}

/** The message is read out of the document beside the code, where the body carries one. */
async function failureOf(
  configuration: AzureBlobConfiguration,
  request: AzureBlobRequest,
  response: Response,
  made: { readonly attempts: number; readonly underRefreshedToken: boolean },
): Promise<StorageError> {
  return providerError(configuration.container, {
    operation: request.operation,
    method: request.method,
    key: request.key,
    copySource: request.copySource,
    status: response.status,
    headers: response.headers,
    providerMessage: await readMessage(request, response),
    ...made,
  });
}

/**
 * The `Message` of the error document, read to the end, which is also what releases the
 * connection the next attempt needs. A body that is no error document — an HTML page from
 * a proxy in between, one that broke on the way — leaves the message unset rather than
 * failing on its way to reporting a failure.
 */
async function readMessage(
  request: AzureBlobRequest,
  response: Response,
): Promise<string | undefined> {
  if (request.method === "HEAD") {
    await response.body?.cancel();

    return undefined;
  }

  try {
    return errorMessageOf(await response.text());
  } catch (failure) {
    if (failure instanceof Error && failure.name === "AbortError") throw failure;

    return undefined;
  }
}

/** The `Message` of an error document, or nothing for a body that is none. */
export function errorMessageOf(body: string): string | undefined {
  try {
    const document = parseXml(body);
    const message = document.children.find((child) => child.name === "Message")?.text;

    return document.name === "Error" && message !== "" ? message : undefined;
  } catch (failure) {
    if (failure instanceof Error && failure.name === "AbortError") throw failure;

    return undefined;
  }
}

// Spec 4.10: an aborted signal produces the runtime's `AbortError` and never a
// `StorageError`, so the one failure `fetch` throws that is not a transport failure
// travels on untouched.
function transportFailure(
  configuration: AzureBlobConfiguration,
  request: AzureBlobRequest,
  failure: unknown,
  attempts: number,
): unknown {
  if (failure instanceof Error && failure.name === "AbortError") return failure;

  return azureBlobError(configuration.container, {
    code: "NetworkError",
    message: `The request received no response: ${String(failure)}`,
    operation: request.operation,
    key: request.key,
    attempts,
    retryable: true,
    cause: failure,
  });
}
