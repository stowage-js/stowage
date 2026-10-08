import type { CapabilityName, PresignedPut } from "@stowage/core";

import type { GcsConfiguration, GcsSigner } from "./configuration.ts";
import { heldContentHeaders, signedContentHeaders } from "./content-headers.ts";
import { requireKey } from "./key.ts";
import {
  optionError,
  presignGetOptionKeys,
  presignPutOptionKeys,
  requireKnownOptions,
} from "./options.ts";
import type { HeaderField, QueryParameter } from "./request.ts";
import { resolvePrivateKey, signWith } from "./private-key.ts";
import { signBlobAs } from "./sign-blob.ts";
import { type Sign, signUrl } from "./signed-url.ts";

export interface GcsPresignGetOptions {
  /**
   * Seconds, 1 to 604800; anything else is `InvalidOption` before anything is sent.
   * The URL counts them from the moment of signing. One signed through `signBlob` may stop
   * working 12 hours after that, whatever this asked for.
   */
  expiresIn: number;
  responseContentType?: string;
  /** Not checked for ASCII: a name outside it goes as RFC 6266's `filename*=UTF-8''…`. */
  responseContentDisposition?: string;
}

export interface GcsPresignPutOptions {
  /**
   * Seconds, 1 to 604800; anything else is `InvalidOption` before anything is sent.
   * The URL counts them from the moment of signing. One signed through `signBlob` may stop
   * working 12 hours after that, whatever this asked for.
   */
  expiresIn: number;
  /** Bound exactly, case and parameters included: an upload of another type is refused. */
  contentType: string;
  /**
   * Bound exactly, so the client reports the length and the server signs that number. A
   * finite, non-negative integer; anything else is `InvalidOption` before anything is sent.
   */
  contentLength: number;
  /**
   * Checked as `put` checks it, signed as `cache-control` and handed back in `headers` where
   * given. Left out, it is not bound: whoever holds the URL may send it (ADR 0063).
   */
  cacheControl?: string;
  /** Bound as `content-disposition`, as `cacheControl` is. */
  contentDisposition?: string;
  /** Bound as `content-language`, as `cacheControl` is. */
  contentLanguage?: string;
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

  return await presignedUrl(configuration, signer, {
    method: "GET",
    operation,
    key,
    query,
    headers: [],
    expiresIn,
  });
}

/**
 * Spec 9.9: `PUT` on a writable key, with the content type, the content length and each
 * content header given bound through signed headers beside `host`. All but the length are
 * handed back to send beside the body, since a client sets the length itself (spec 4.13).
 */
export async function presignPut(
  configuration: GcsConfiguration,
  signer: GcsSigner,
  key: string,
  options: GcsPresignPutOptions,
  capabilities: readonly CapabilityName[],
): Promise<PresignedPut> {
  const operation = "presignPut";

  requireKey(configuration.bucket, key, "writable", operation);

  const given = readGroup(configuration.bucket, options, presignPutOptionKeys, operation);
  const expiresIn = readExpiresIn(configuration.bucket, given.expiresIn, operation);
  const contentType = readText(configuration.bucket, given.contentType, "contentType", operation);
  const contentLength = readContentLength(configuration.bucket, given.contentLength, operation);
  const held = heldContentHeaders(
    configuration.bucket,
    options,
    contentType,
    key,
    operation,
    capabilities,
  );
  const contentHeaders = signedContentHeaders(held);

  const url = await presignedUrl(configuration, signer, {
    method: "PUT",
    operation,
    key,
    query: [],
    headers: [["content-type", contentType], ["content-length", contentLength], ...contentHeaders],
    expiresIn,
  });

  return { url, headers: { "content-type": contentType, ...Object.fromEntries(contentHeaders) } };
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
async function presignedUrl(
  configuration: GcsConfiguration,
  signer: GcsSigner,
  request: Presignable,
): Promise<string> {
  const sign = await signOfCall(configuration, signer, request);

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
 * How this one URL is signed, resolved for it alone (spec 9.9): with the local key imported
 * again, or through a `signBlob` under a token resolved for its request.
 */
async function signOfCall(
  configuration: GcsConfiguration,
  signer: GcsSigner,
  request: Presignable,
): Promise<Sign> {
  const use = { bucket: configuration.bucket, operation: request.operation, key: request.key };

  if ("credentials" in signer) {
    return signBlobAs(configuration, {
      serviceAccount: signer.serviceAccount,
      credentials: signer.credentials,
      ...use,
    });
  }

  return signWith(await resolvePrivateKey(signer.privateKey, use));
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
