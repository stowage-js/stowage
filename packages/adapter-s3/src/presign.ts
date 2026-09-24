import { isStorageError } from "@stowage/core";

import type { HeaderField, QueryParameter } from "./canonical.ts";
import type { S3Configuration } from "./configuration.ts";
import { resolveCredentials } from "./credentials.ts";
import { requireKey } from "./key.ts";
import {
  optionError,
  presignGetOptionKeys,
  presignPutOptionKeys,
  requireKnownOptions,
} from "./options.ts";
import { pathOf, urlOf } from "./request.ts";
import { presignRequest } from "./sign.ts";
import { inStorage, s3Error } from "./storage-error.ts";

export interface S3PresignGetOptions {
  /** Seconds, 1 to 604800. The credential that signs may cut the lifetime shorter. */
  expiresIn: number;
  responseContentType?: string;
  responseContentDisposition?: string;
  responseCacheControl?: string;
  responseExpires?: string;
}

export interface S3PresignPutOptions {
  /** Seconds, 1 to 604800. The credential that signs may cut the lifetime shorter. */
  expiresIn: number;
  /** Bound exactly: an upload of another type is refused by the provider. */
  contentType: string;
  /**
   * Bound exactly, so the client reports the length and the server signs that number: an
   * upload of another length is refused, and there is no upper bound to sign instead. A
   * finite, non-negative integer; anything else is `InvalidOption` before signing.
   */
  contentLength: number;
}

/** The ceiling SigV4 query signing sets on `X-Amz-Expires`, a week in seconds. */
const longestLifetime = 604_800;

/** Each override of spec 7.10 and the query parameter S3 answers as its response header. */
const responseOverrides = [
  ["responseContentType", "response-content-type"],
  ["responseContentDisposition", "response-content-disposition"],
  ["responseCacheControl", "response-cache-control"],
  ["responseExpires", "response-expires"],
] as const;

/** Spec 7.10: `GetObject` on an addressable key, the overrides carried in the query. */
export async function presignGet(
  configuration: S3Configuration,
  key: string,
  options: S3PresignGetOptions,
): Promise<string> {
  const operation = "presignGet";

  requireKey(configuration.bucket, key, "addressable", operation);

  const given = readGroup(configuration.bucket, options, presignGetOptionKeys, operation);
  const expiresIn = readExpiresIn(configuration.bucket, given.expiresIn, operation);
  const query: QueryParameter[] = [];

  for (const [option, parameter] of responseOverrides) {
    const value = given[option];

    if (value === undefined) continue;

    query.push([parameter, readText(configuration.bucket, value, option, operation)]);
  }

  return await presignedUrl(configuration, {
    method: "GET",
    operation,
    key,
    query,
    headers: [],
    expiresIn,
  });
}

/**
 * Spec 7.10: `PutObject` on a writable key, with the content type and the content length
 * bound through signed headers. Nothing else is signed in: no user metadata and no
 * checksum, which the browser would have to match exactly for a `403` that names nothing
 * (ADR 0011).
 */
export async function presignPut(
  configuration: S3Configuration,
  key: string,
  options: S3PresignPutOptions,
): Promise<string> {
  const operation = "presignPut";

  requireKey(configuration.bucket, key, "writable", operation);

  const given = readGroup(configuration.bucket, options, presignPutOptionKeys, operation);
  const expiresIn = readExpiresIn(configuration.bucket, given.expiresIn, operation);
  const contentType = readText(configuration.bucket, given.contentType, "contentType", operation);
  const contentLength = readContentLength(configuration.bucket, given.contentLength, operation);

  return await presignedUrl(configuration, {
    method: "PUT",
    operation,
    key,
    query: [],
    headers: [
      ["content-type", contentType],
      ["content-length", contentLength],
    ],
    expiresIn,
  });
}

interface Presignable {
  readonly method: string;
  readonly operation: string;
  readonly key: string;
  readonly query: readonly QueryParameter[];
  readonly headers: readonly HeaderField[];
  readonly expiresIn: number;
}

/**
 * Spec 7.10: nothing is sent, so the one failure left after the options is the
 * credential's. It is resolved for every URL, as for every request (spec 7.3).
 */
async function presignedUrl(configuration: S3Configuration, request: Presignable): Promise<string> {
  const credentials = await resolveCredentials(configuration.credentials, {
    forceRefresh: false,
  }).catch((failure: unknown) => {
    if (isStorageError(failure) && failure.code === "InvalidCredentials") {
      throw inStorage(failure, configuration.bucket, request.operation, request.key);
    }

    throw s3Error(configuration.bucket, {
      code: "InvalidCredentials",
      message: "The credential resolver failed",
      operation: request.operation,
      key: request.key,
      attempts: 0,
      cause: failure,
    });
  });
  const path = pathOf(configuration, request.key);
  const presigned = await presignRequest({
    method: request.method,
    host: configuration.host,
    path,
    query: request.query,
    headers: request.headers,
    credentials,
    region: configuration.region,
    service: "s3",
    date: new Date(),
    expiresIn: request.expiresIn,
  });

  return urlOf(configuration, path, presigned.query);
}

/**
 * The options as a group whose keys are all known. A caller outside TypeScript may hand
 * no group at all, which reads as one holding nothing, so the required `expiresIn` is
 * what the refusal names.
 */
function readGroup(
  bucket: string,
  options: object,
  known: readonly string[],
  operation: string,
): Readonly<Record<string, unknown>> {
  if (typeof options !== "object" || options === null) return {};

  requireKnownOptions(bucket, options, known, operation);

  return { ...options };
}

/** ADR 0011: outside the week SigV4 allows, refused rather than signed for a `403`. */
function readExpiresIn(bucket: string, value: unknown, operation: string): number {
  const inRange = typeof value === "number" && value >= 1 && value <= longestLifetime;

  if (inRange && Number.isInteger(value)) return value;

  throw optionError(
    bucket,
    "expiresIn",
    `takes the whole seconds 1 to ${longestLifetime}, the lifetime SigV4 allows`,
    operation,
  );
}

// Written out as digits, because `String` writes an integer from `1e21` up as an exponent.
function readContentLength(bucket: string, value: unknown, operation: string): string {
  if (typeof value === "number" && Number.isInteger(value) && value >= 0) {
    return BigInt(value).toString();
  }

  throw optionError(bucket, "contentLength", "takes a finite, non-negative integer", operation);
}

function readText(bucket: string, value: unknown, option: string, operation: string): string {
  if (typeof value === "string" && value !== "") return value;

  throw optionError(bucket, option, "takes a non-empty string", operation);
}
