import type { PresignedPut } from "@stowage/core";

import type { GcsConfiguration, GcsSigner } from "./configuration.ts";
import { requireKey } from "./key.ts";
import {
  optionError,
  presignGetOptionKeys,
  presignPutOptionKeys,
  requireKnownOptions,
} from "./options.ts";
import type { HeaderField, QueryParameter } from "./request.ts";
import { signBlobAs } from "./sign-blob.ts";
import { signUrl } from "./signed-url.ts";
import { importPrivateKey, type Sign, signWith } from "./signer.ts";
import { gcsError, inStorage } from "./storage-error.ts";

export interface GcsPresignGetOptions {
  /** Seconds, 1 to 604800; anything else is `InvalidOption` before anything is sent. */
  expiresIn: number;
  responseContentType?: string;
  /** Not checked for ASCII: a name outside it goes as RFC 6266's `filename*=UTF-8''…`. */
  responseContentDisposition?: string;
}

export interface GcsPresignPutOptions {
  /** Seconds, 1 to 604800; anything else is `InvalidOption` before anything is sent. */
  expiresIn: number;
  /** Bound exactly, case and parameters included: an upload of another type is refused. */
  contentType: string;
  /**
   * Bound exactly, so the client reports the length and the server signs that number. A
   * finite, non-negative integer; anything else is `InvalidOption` before anything is sent.
   */
  contentLength: number;
}

/** The week V4 signing allows `X-Goog-Expires`; GCS refuses `604801` with `400`. */
const longestLifetime = 604_800;

/** Each override of spec 9.9 and the query parameter GCS answers as its response header. */
const responseOverrides = [
  ["responseContentType", "response-content-type"],
  ["responseContentDisposition", "response-content-disposition"],
] as const;

/** Spec 9.9: `GET` on an addressable key, the two overrides carried in the query. */
export async function presignGet(
  configuration: GcsConfiguration,
  signer: GcsSigner,
  key: string,
  options: GcsPresignGetOptions,
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

  return await signedUrl(configuration, signer, {
    method: "GET",
    operation,
    key,
    query,
    headers: [],
    expiresIn,
  });
}

/**
 * Spec 9.9: `PUT` on a writable key, with the content type and the content length bound
 * through signed headers beside `host`. Only the content type is handed back to send beside
 * the body, since a client sets the length itself (spec 4.13).
 */
export async function presignPut(
  configuration: GcsConfiguration,
  signer: GcsSigner,
  key: string,
  options: GcsPresignPutOptions,
): Promise<PresignedPut> {
  const operation = "presignPut";

  requireKey(configuration.bucket, key, "writable", operation);

  const given = readGroup(configuration.bucket, options, presignPutOptionKeys, operation);
  const expiresIn = readExpiresIn(configuration.bucket, given.expiresIn, operation);
  const contentType = readText(configuration.bucket, given.contentType, "contentType", operation);
  const contentLength = readContentLength(configuration.bucket, given.contentLength, operation);

  const url = await signedUrl(configuration, signer, {
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

  return { url, headers: { "content-type": contentType } };
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
 * Spec 9.9: path-style on the endpoint, its path kept, and `X-Goog-Date` the moment of
 * signing, not dated back: expiry counts from it, and GCS takes a date up to about 15
 * minutes ahead of its clock (ADR 0035).
 */
async function signedUrl(
  configuration: GcsConfiguration,
  signer: GcsSigner,
  request: Presignable,
): Promise<string> {
  const sign = await signerOfCall(configuration, signer, request.operation, request.key);

  return await signUrl(
    {
      method: request.method,
      origin: configuration.origin,
      path: `${configuration.basePath}/${configuration.bucket}/${request.key}`,
      headers: request.headers,
      query: request.query,
      serviceAccount: signer.serviceAccount,
      signedAt: new Date(),
      expiresIn: request.expiresIn,
    },
    sign,
  );
}

/**
 * The signer resolved for this one URL and cached nowhere (spec 9.9): the local key imported
 * again, or a `signBlob` under a token resolved for its request.
 */
async function signerOfCall(
  configuration: GcsConfiguration,
  signer: GcsSigner,
  operation: string,
  key: string,
): Promise<Sign> {
  if ("credentials" in signer) {
    return signBlobAs(configuration, {
      serviceAccount: signer.serviceAccount,
      credentials: signer.credentials,
      operation,
      key,
    });
  }

  const { privateKey } = signer;
  const resolved: unknown = await Promise.resolve(
    typeof privateKey === "function" ? privateKey({ forceRefresh: false }) : privateKey,
  ).catch((failure: unknown) => {
    throw inStorage(failure, configuration.bucket, operation, key);
  });
  const imported = await importPrivateKey(resolved);

  if (imported instanceof CryptoKey) return signWith(imported);

  throw gcsError(configuration.bucket, {
    code: "InvalidCredentials",
    message: `The signer's \`privateKey\` ${imported.refused}`,
    operation,
    key,
    attempts: 0,
  });
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

function readExpiresIn(bucket: string, value: unknown, operation: string): number {
  const inRange = typeof value === "number" && value >= 1 && value <= longestLifetime;

  if (inRange && Number.isInteger(value)) return value;

  throw optionError(
    bucket,
    "expiresIn",
    `takes the whole seconds 1 to ${longestLifetime}, the week a V4 signature allows`,
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
