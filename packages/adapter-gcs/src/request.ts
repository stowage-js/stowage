import {
  type FailureReading,
  type RefusedAnswer,
  type Resolvable,
  sendRequest,
  type UnansweredRule,
} from "@stowage/core";

import type { GcsConfiguration } from "./configuration.ts";
import { type GcsCredentials, resolveCredentials } from "./credentials.ts";
import { readErrorBody, readFailedAnswer } from "./provider-code.ts";

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
  /** Set on every request of a resumable session, whose answers name no `requestId` (spec 9.8). */
  readonly session?: boolean;
  /** Set on a request to the session URI itself, the start's aside, whose `404` says the session is gone. */
  readonly sessionUri?: boolean;
  /** What follows an attempt the request's effect may have happened in (ADR 0057). */
  readonly unanswered?: UnansweredRule;
  readonly signal?: AbortSignal;
}

/**
 * A request to a resumable session's URI, which authorizes it on its own: it carries no
 * credential and goes where the start of the session pointed (ADR 0036).
 */
export interface SessionRequest {
  readonly method: string;
  readonly key: string;
  readonly uri: string;
  readonly headers?: readonly HeaderField[];
  readonly body?: Uint8Array<ArrayBuffer>;
  readonly signal?: AbortSignal;
}

/** Spec 9.8: the identifier Google asks for when a request is reported to its support. */
export const requestIdHeader = "x-guploader-uploadid";

/** What a session answers a chunk it persisted without committing, `Range` naming how far. */
export const resumeIncomplete = 308;

/** What `encodeURIComponent` leaves alone and RFC 3986 counts as reserved. */
const reservedByEncodeUriComponent = /[!'()*]/gu;

/**
 * One request to the JSON API, answered by the response the provider sent or rejected with
 * its failure. The attempts of spec 9.5 and the repeat under a refreshed token of spec 9.3
 * live in `@stowage/core` (ADR 0057). A token resolved for the attempt alone authorizes it,
 * and every attempt resolves one again.
 */
export async function send(
  configuration: GcsConfiguration,
  request: GcsRequest,
): Promise<Response> {
  const response = await sendRequest({
    provider: "gcs",
    bucket: configuration.bucket,
    operation: request.operation,
    key: request.key,
    method: request.method,
    maxAttempts: configuration.maxAttempts,
    signal: request.signal,
    unanswered: request.unanswered,
    prepare: async ({ forceRefresh }) => {
      const credentials = await resolveCredentials(
        request.credentials ?? configuration.credentials,
        { forceRefresh },
      );

      return {
        url: urlOf(configuration, request),
        headers: [
          ...(request.headers ?? []),
          ["authorization", `Bearer ${credentials.accessToken}`],
        ],
        body: request.body,
        refreshable: true,
      };
    },
    readFailure: (answer) => readFailure(request, answer),
  });

  return request.session === true ? withoutRequestId(response) : response;
}

/**
 * One request to a resumable session, sent once: what a session repeats is a chunk from
 * the first byte it has not acknowledged, which may take several requests (ADR 0036). A
 * `308` is an answer here, as success is, and whoever sent the chunk reads its `Range`.
 */
export async function sendToSession(
  configuration: GcsConfiguration,
  request: SessionRequest,
): Promise<Response> {
  const described: GcsRequest = {
    method: request.method,
    operation: "put",
    key: request.key,
    path: "",
    session: true,
    sessionUri: true,
  };

  return withoutRequestId(
    await sendRequest({
      provider: "gcs",
      bucket: configuration.bucket,
      operation: described.operation,
      key: request.key,
      method: request.method,
      maxAttempts: 1,
      signal: request.signal,
      answeredBy: [resumeIncomplete],
      prepare: async () =>
        await Promise.resolve({
          url: request.uri,
          headers: request.headers ?? [],
          body: request.body,
          refreshable: false,
        }),
      readFailure: (answer) => readFailure(described, answer),
    }),
  );
}

/** The query that pins a request to one generation of the object, where it names one. */
export function pinnedTo(generation: string | undefined): readonly QueryParameter[] {
  return generation === undefined ? [] : [["generation", generation]];
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

/**
 * The provider code and the message are read out of the body, where it carries them
 * (spec 9.8). A session's answers are read without their request id, which holds the
 * value that authorizes the session.
 */
function readFailure(request: GcsRequest, answer: RefusedAnswer): FailureReading {
  const body = answer.body === undefined ? {} : readErrorBody(answer.body);
  const requestId =
    request.session === true ? undefined : (answer.headers.get(requestIdHeader) ?? undefined);

  return readFailedAnswer(request.key, requestId, {
    status: answer.status,
    method: request.method,
    providerCode: body.providerCode,
    providerMessage: body.message,
    media: request.media === true,
    carriesCursor: request.carriesCursor === true,
    sessionUri: request.sessionUri === true,
    underRefreshedToken: answer.refreshed,
    headers: answer.headers,
  });
}

/**
 * Spec 9.8: on a resumable session `x-guploader-uploadid` holds the value that authorizes the
 * session, so its answers are read without it, and neither a failure nor a malformed answer
 * can report it as `requestId`.
 */
function withoutRequestId(response: Response): Response {
  const headers = new Headers(response.headers);

  headers.delete(requestIdHeader);

  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
}
