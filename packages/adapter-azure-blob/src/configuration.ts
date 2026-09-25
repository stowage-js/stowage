import type { Resolvable, StorageError } from "@stowage/core";

import type { AzureBlobCredentials } from "./credentials.ts";
import { optionError as refuseOption, requireKnownOptions } from "./options.ts";

export interface AzureBlobAdapterOptions {
  /** Names the endpoint and enters every Shared Key signature; nothing reads it elsewhere. */
  account: string;
  container: string;
  /**
   * `https://<account>.blob.core.windows.net` where absent. Given, an absolute URL with no
   * userinfo, no query and no fragment, `https:` always and `http:` only where the host is
   * a loopback address; anything else is `InvalidOption` at construction. A path in it
   * becomes the prefix of every request path.
   */
  endpoint?: string;
  credentials: Resolvable<AzureBlobCredentials>;
  /**
   * How often one HTTP request is attempted while its failure is transient: a response of
   * `408`, `429` or `5xx`, or none at all. `false` sends one attempt.
   */
  retry?:
    | false
    | {
        /** 1 to 3, and 3 where absent. Outside that range it is `InvalidOption`. */
        maxAttempts?: number;
      };
  /** How a stream that fills more than one part is uploaded. */
  multipart?: {
    /** Bytes per part, 5 MiB to 4,000 MiB, and 8 MiB where absent. */
    partSize?: number;
    /** Parts in flight, 1 to 16, and 4 where absent. */
    concurrency?: number;
  };
}

/** The options as the storage holds them, every default filled in and nothing to refuse. */
export interface AzureBlobConfiguration {
  readonly account: string;
  readonly container: string;
  readonly protocol: string;
  /** What the request is addressed to, port included. */
  readonly host: string;
  /** What the endpoint puts in front of the path, without a trailing slash. */
  readonly basePath: string;
  readonly credentials: Resolvable<AzureBlobCredentials>;
  readonly maxAttempts: number;
  readonly partSize: number;
  readonly concurrency: number;
}

const adapterOptionKeys: readonly string[] = [
  "account",
  "container",
  "endpoint",
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
const partSizeRange = { least: 5 * mebibyte, most: 4000 * mebibyte };
const concurrencyRange = { least: 1, most: 16 };

/**
 * Azure's rule for an account name. Without an endpoint the account becomes the first
 * label of the host a bearer token is sent to, so a name that could end that label and
 * start another host never reaches a request.
 */
const accountName = /^[a-z0-9]{3,24}$/u;

/**
 * IPv4 loopback is the whole `127.0.0.0/8` block and IPv6 loopback the single `::1`.
 * `localhost` stands beside them because RFC 6761 binds the name to one of the two, which
 * is what makes it an address spec 8.1 accepts rather than a host that might be anywhere.
 */
const loopbackHosts = /^(?:localhost|127(?:\.\d{1,3}){3}|\[::1\])$/u;

/**
 * Spec 8.1: every option is validated where the storage is constructed, an unknown key
 * and a value outside its range are `InvalidOption` naming the key, and no value is
 * clamped onto the range it missed.
 */
export function readConfiguration(options: AzureBlobAdapterOptions): AzureBlobConfiguration {
  const container = typeof options.container === "string" ? options.container : "";

  requireKnownOptions(container, options, adapterOptionKeys, "azureBlobStorage");
  requireFilled(container, options.account, "account");
  requireFilled(container, options.container, "container");

  if (!accountName.test(options.account)) {
    throw optionError(container, "account", "takes 3 to 24 lower-case letters and digits");
  }

  if (options.credentials === undefined) {
    throw optionError(container, "credentials", "is required: no unsigned request is sent");
  }

  return {
    account: options.account,
    container: options.container,
    ...readEndpoint(container, options),
    credentials: options.credentials,
    maxAttempts: readMaxAttempts(container, options.retry),
    ...readMultipart(container, options.multipart),
  };
}

interface EndpointAddress {
  readonly protocol: string;
  readonly host: string;
  readonly basePath: string;
}

/**
 * Spec 8.1 takes the endpoint rules of spec 7.1: no endpoint addresses the account in the
 * public cloud, a configured one is an absolute URL without userinfo, query and fragment,
 * and `http:` is accepted for a loopback host alone. Its path is kept, which is how
 * Azurite's `/devstoreaccount1` reaches every request without a case of its own.
 */
function readEndpoint(container: string, options: AzureBlobAdapterOptions): EndpointAddress {
  if (options.endpoint === undefined) {
    return { protocol: "https:", host: `${options.account}.blob.core.windows.net`, basePath: "" };
  }

  if (typeof options.endpoint !== "string") {
    throw optionError(container, "endpoint", "is no absolute URL");
  }

  const parsed = URL.parse(options.endpoint);

  if (parsed === null) throw optionError(container, "endpoint", "is no absolute URL");
  if (parsed.username !== "" || parsed.password !== "") {
    throw optionError(container, "endpoint", "carries userinfo");
  }
  if (parsed.search !== "") throw optionError(container, "endpoint", "carries a query");
  if (parsed.hash !== "") throw optionError(container, "endpoint", "carries a fragment");
  if (parsed.protocol !== "https:" && !isLoopbackHttp(parsed)) {
    throw optionError(container, "endpoint", "is neither `https:` nor `http:` to a loopback host");
  }

  return {
    protocol: parsed.protocol,
    host: parsed.host,
    basePath: parsed.pathname.replace(/\/$/u, ""),
  };
}

function isLoopbackHttp(endpoint: URL): boolean {
  return endpoint.protocol === "http:" && loopbackHosts.test(endpoint.hostname);
}

function readMaxAttempts(container: string, retry: AzureBlobAdapterOptions["retry"]): number {
  if (retry === false) return 1;
  if (retry === undefined) return defaultMaxAttempts;

  requireGroup(container, retry, "retry");
  requireKnownOptions(container, retry, retryOptionKeys, "azureBlobStorage");

  return readInRange(
    container,
    retry.maxAttempts,
    "maxAttempts",
    maxAttemptsRange,
    defaultMaxAttempts,
  );
}

function readMultipart(
  container: string,
  multipart: AzureBlobAdapterOptions["multipart"],
): { partSize: number; concurrency: number } {
  if (multipart !== undefined) {
    requireGroup(container, multipart, "multipart");
    requireKnownOptions(container, multipart, multipartOptionKeys, "azureBlobStorage");
  }

  return {
    partSize: readInRange(
      container,
      multipart?.partSize,
      "partSize",
      partSizeRange,
      defaultPartSize,
    ),
    concurrency: readInRange(
      container,
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
  container: string,
  value: number | undefined,
  option: string,
  range: Range,
  fallback: number,
): number {
  if (value === undefined) return fallback;

  if (!Number.isInteger(value) || value < range.least || value > range.most) {
    throw optionError(container, option, `takes the integers ${range.least} to ${range.most}`);
  }

  return value;
}

/**
 * A group of options is an object. Without this, `Object.keys` reads `retry: true` as a
 * group with no key and hands back the default, and `retry: null` throws a `TypeError`
 * where spec 8.1 asks for `InvalidOption`.
 */
function requireGroup(container: string, group: unknown, option: string): void {
  if (typeof group === "object" && group !== null) return;

  throw optionError(container, option, "takes a group of options");
}

function requireFilled(container: string, value: string, option: string): void {
  if (typeof value === "string" && value !== "") return;

  throw optionError(container, option, "is empty");
}

// Every refusal here names the call that constructed the storage, which is where spec
// 8.1 has the configuration read.
function optionError(container: string, option: string, expectation: string): StorageError {
  return refuseOption(container, option, expectation, "azureBlobStorage");
}
