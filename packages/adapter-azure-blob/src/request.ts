import { parseXml, type PreparedAttempt, sendRequest } from "@stowage/core";

import type { AzureBlobConfiguration } from "./configuration.ts";
import { type AzureBlobCredentials, resolveCredentials } from "./credentials.ts";
import { readFailedResponse } from "./provider-code.ts";
import {
  type HeaderField,
  type QueryParameter,
  type SignableRequest,
  signSharedKey,
} from "./sign.ts";

export interface AzureBlobRequest {
  readonly method: string;
  readonly operation: string;
  /** The key the request addresses, absent for a request about the container itself. */
  readonly key?: string;
  /** Set for a request about the account's blob service, which addresses no container. */
  readonly toService?: boolean;
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
 * failure. The attempts of spec 8.5 and the repeat under a refreshed access token of spec
 * 8.3 live in `@stowage/core` (ADR 0057).
 */
export async function send(
  configuration: AzureBlobConfiguration,
  request: AzureBlobRequest,
): Promise<Response> {
  return await sendRequest({
    provider: "azure-blob",
    bucket: configuration.container,
    operation: request.operation,
    key: request.key,
    method: request.method,
    maxAttempts: configuration.maxAttempts,
    signal: request.signal,
    prepare: async ({ forceRefresh }) => await prepare(configuration, request, forceRefresh),
    readFailure: (answer) =>
      readFailedResponse({
        method: request.method,
        key: request.key,
        copySource: request.copySource,
        status: answer.status,
        headers: answer.headers,
        providerMessage: answer.body === undefined ? undefined : errorMessageOf(answer.body),
        underRefreshedToken: answer.refreshed,
      }),
  });
}

/**
 * One authorized request, which is the attempt CONTEXT.md names and what a repeat
 * repeats: the credential is resolved and the request dated and signed anew. Spec 8.3
 * refreshes an access token the provider refused, and never an account key, which a
 * refresh does not make valid.
 */
async function prepare(
  configuration: AzureBlobConfiguration,
  request: AzureBlobRequest,
  forceRefresh: boolean,
): Promise<PreparedAttempt> {
  const path = request.toService
    ? encodePath(`${configuration.basePath}/`)
    : requestPath(configuration, request.key);
  const query = request.query ?? [];
  const credentials = await resolveCredentials(configuration.credentials, { forceRefresh });
  const body = typeof request.body === "function" ? await request.body(credentials) : request.body;
  const requested =
    typeof request.headers === "function" ? await request.headers(credentials) : request.headers;
  const headers = await authorize(
    configuration,
    { method: request.method, path, query, headers: requested ?? [] },
    body,
    credentials,
  );

  return {
    url: urlOf(configuration, path, query),
    headers: [...headers, identityEncoding],
    body,
    refreshable: "accessToken" in credentials,
  };
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
