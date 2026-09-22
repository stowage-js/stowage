import type { Resolvable, StorageError } from "@stowage/core";

import type { S3Credentials } from "./credentials.ts";
import { optionError as refuseOption, requireKnownOptions } from "./options.ts";

export interface S3AdapterOptions {
  bucket: string;
  region: string;
  endpoint?: string;
  forcePathStyle?: boolean;
  credentials: Resolvable<S3Credentials>;
  retry?: false | { maxAttempts?: number };
  multipart?: { partSize?: number; concurrency?: number };
}

/** The options as the storage holds them, every default filled in and nothing to refuse. */
export interface S3Configuration {
  readonly bucket: string;
  readonly region: string;
  readonly protocol: string;
  /** What the request is addressed to and what `host:` is signed as, port included. */
  readonly host: string;
  /** What the endpoint puts in front of the path, without a trailing slash. */
  readonly basePath: string;
  readonly forcePathStyle: boolean;
  readonly credentials: Resolvable<S3Credentials>;
  readonly maxAttempts: number;
  readonly partSize: number;
  readonly concurrency: number;
}

const adapterOptionKeys: readonly string[] = [
  "bucket",
  "region",
  "endpoint",
  "forcePathStyle",
  "credentials",
  "retry",
  "multipart",
];
const retryOptionKeys: readonly string[] = ["maxAttempts"];
const multipartOptionKeys: readonly string[] = ["partSize", "concurrency"];

const mebibyte = 1024 * 1024;

const defaultMaxAttempts = 3;
const defaultPartSize = 8 * mebibyte;
const defaultConcurrency = 4;

const maxAttemptsRange = { least: 1, most: 3 };
const partSizeRange = { least: 5 * mebibyte, most: 5 * 1024 * mebibyte };
const concurrencyRange = { least: 1, most: 16 };

/**
 * IPv4 loopback is the whole `127.0.0.0/8` block and IPv6 loopback the single `::1`.
 * `localhost` stands beside them because RFC 6761 binds the name to one of the two, which
 * is what makes it an address spec 7.1 accepts rather than a host that might be anywhere.
 */
const loopbackHosts = /^(?:localhost|127(?:\.\d{1,3}){3}|\[::1\])$/u;

/**
 * Spec 7.1: every option is validated where the storage is constructed, an unknown key
 * and a value outside its range are `InvalidOption` naming the key, and no value is
 * clamped onto the range it missed.
 */
export function readConfiguration(options: S3AdapterOptions): S3Configuration {
  const bucket = typeof options.bucket === "string" ? options.bucket : "";

  requireKnownOptions(bucket, options, adapterOptionKeys, "s3Storage");
  requireFilled(bucket, options.bucket, "bucket");
  requireFilled(bucket, options.region, "region");

  if (options.credentials === undefined) {
    throw optionError(bucket, "credentials", "is required: v0.1 sends no unsigned request");
  }

  const forcePathStyle = readFlag(bucket, options.forcePathStyle, "forcePathStyle");
  const endpoint = readEndpoint(bucket, options, forcePathStyle);

  return {
    bucket: options.bucket,
    region: options.region,
    ...endpoint,
    forcePathStyle,
    credentials: options.credentials,
    maxAttempts: readMaxAttempts(bucket, options.retry),
    ...readMultipart(bucket, options.multipart),
  };
}

interface EndpointAddress {
  readonly protocol: string;
  readonly host: string;
  readonly basePath: string;
}

/**
 * Spec 7.1: no endpoint addresses AWS S3, a configured one is an absolute URL without
 * userinfo, query and fragment, and `http:` is accepted for a loopback host alone.
 * Addressing is virtual-hosted unless `forcePathStyle` moves the bucket into the path.
 */
function readEndpoint(
  bucket: string,
  options: S3AdapterOptions,
  forcePathStyle: boolean,
): EndpointAddress {
  if (options.endpoint === undefined) {
    return {
      protocol: "https:",
      host: hostFor(`s3.${options.region}.amazonaws.com`, options.bucket, forcePathStyle),
      basePath: "",
    };
  }

  if (typeof options.endpoint !== "string") {
    throw optionError(bucket, "endpoint", "is no absolute URL");
  }

  const parsed = URL.parse(options.endpoint);

  if (parsed === null) throw optionError(bucket, "endpoint", "is no absolute URL");
  if (parsed.username !== "" || parsed.password !== "") {
    throw optionError(bucket, "endpoint", "carries userinfo");
  }
  if (parsed.search !== "") throw optionError(bucket, "endpoint", "carries a query");
  if (parsed.hash !== "") throw optionError(bucket, "endpoint", "carries a fragment");
  if (parsed.protocol !== "https:" && !isLoopbackHttp(parsed)) {
    throw optionError(bucket, "endpoint", "is neither `https:` nor `http:` to a loopback host");
  }

  return {
    protocol: parsed.protocol,
    host: hostFor(parsed.host, options.bucket, forcePathStyle),
    basePath: parsed.pathname === "/" ? "" : parsed.pathname.replace(/\/$/u, ""),
  };
}

function isLoopbackHttp(endpoint: URL): boolean {
  return endpoint.protocol === "http:" && loopbackHosts.test(endpoint.hostname);
}

function hostFor(host: string, bucket: string, forcePathStyle: boolean): string {
  return forcePathStyle ? host : `${bucket}.${host}`;
}

function readMaxAttempts(bucket: string, retry: S3AdapterOptions["retry"]): number {
  if (retry === false) return 1;
  if (retry === undefined) return defaultMaxAttempts;

  requireGroup(bucket, retry, "retry");
  requireKnownOptions(bucket, retry, retryOptionKeys, "s3Storage");

  return readInRange(
    bucket,
    retry.maxAttempts,
    "maxAttempts",
    maxAttemptsRange,
    defaultMaxAttempts,
  );
}

function readMultipart(
  bucket: string,
  multipart: S3AdapterOptions["multipart"],
): { partSize: number; concurrency: number } {
  if (multipart !== undefined) {
    requireGroup(bucket, multipart, "multipart");
    requireKnownOptions(bucket, multipart, multipartOptionKeys, "s3Storage");
  }

  return {
    partSize: readInRange(bucket, multipart?.partSize, "partSize", partSizeRange, defaultPartSize),
    concurrency: readInRange(
      bucket,
      multipart?.concurrency,
      "concurrency",
      concurrencyRange,
      defaultConcurrency,
    ),
  };
}

interface Range {
  readonly least: number;
  readonly most: number;
}

function readInRange(
  bucket: string,
  value: number | undefined,
  option: string,
  range: Range,
  fallback: number,
): number {
  if (value === undefined) return fallback;

  if (!Number.isInteger(value) || value < range.least || value > range.most) {
    throw optionError(bucket, option, `takes the integers ${range.least} to ${range.most}`);
  }

  return value;
}

function readFlag(bucket: string, value: boolean | undefined, option: string): boolean {
  if (value === undefined) return false;
  if (typeof value !== "boolean") throw optionError(bucket, option, "takes a boolean");

  return value;
}

/**
 * A group of options is an object. Without this, `Object.keys` reads `retry: true` as a
 * group with no key and hands back the default, and `retry: null` throws a `TypeError`
 * where spec 7.1 asks for `InvalidOption`.
 */
function requireGroup(bucket: string, group: unknown, option: string): void {
  if (typeof group === "object" && group !== null) return;

  throw optionError(bucket, option, "takes a group of options");
}

function requireFilled(bucket: string, value: string, option: string): void {
  if (typeof value === "string" && value !== "") return;

  throw optionError(bucket, option, "is empty");
}

// Every refusal here names the call that constructed the storage, which is where spec
// 7.1 has the configuration read.
function optionError(bucket: string, option: string, expectation: string): StorageError {
  return refuseOption(bucket, option, expectation, "s3Storage");
}
