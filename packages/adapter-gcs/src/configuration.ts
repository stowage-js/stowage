import { readMaxAttempts, type Resolvable, type StorageError } from "@stowage/core";

import type { GcsCredentials } from "./credentials.ts";
import { optionError as refuseOption, requireKnownOptions } from "./options.ts";

/**
 * Whoever signs the storage's presigned URLs, as the service account named here, in one of
 * two forms told apart by the field present. It is not `Resolvable` as a whole, since it
 * decides whether the storage declares `presignedUrls`; what it holds is resolved on every
 * call and cached nowhere. Checked at construction: a non-empty `serviceAccount` and
 * exactly one of `privateKey` and `credentials`; a violation is `InvalidOption`.
 */
export type GcsSigner =
  | {
      /** The email of the service account the URL is signed as. */
      serviceAccount: string;
      /**
       * The service account's key, which signs locally with Web Crypto and sends no
       * request: a PKCS#8 PEM, as the key file's `private_key` holds it, or an RSA
       * `CryptoKey` able to sign. Anything else is `InvalidCredentials` naming
       * `privateKey`. A URL it signed works until it expires or the key is deleted.
       */
      privateKey: Resolvable<string | CryptoKey>;
    }
  | {
      /** The email of the service account the URL is signed as. */
      serviceAccount: string;
      /**
       * A token of the signer's own, under which each URL costs one `signBlob` request to
       * the IAM Credentials API. It needs the scope `iam` or `cloud-platform`, which the
       * storage's `devstorage.read_write` token lacks, and its principal needs
       * `iam.serviceAccounts.signBlob` on the service account. A URL it signed may stop
       * working 12 hours after signing, whatever `expiresIn` asked for.
       */
      credentials: Resolvable<GcsCredentials>;
    };

export interface GcsAdapterOptions {
  bucket: string;
  /**
   * `https://storage.googleapis.com` where absent. Given, an absolute URL with no userinfo,
   * no query and no fragment, `https:` always and `http:` only where the host is a
   * loopback address; anything else is `InvalidOption` at construction. A path in it
   * becomes the prefix of every request path.
   */
  endpoint?: string;
  credentials: Resolvable<GcsCredentials>;
  /**
   * Given, the storage declares `presignedUrls` and carries `presignGet` and `presignPut`;
   * absent, it carries neither.
   */
  signer?: GcsSigner;
  /**
   * How often one HTTP request is attempted while its failure is transient: a response of
   * `408`, `429` or `5xx`, or none at all. `false` sends one attempt, and does not switch
   * off the one repeat with a fresh access token after the provider answered `401` with
   * `error=invalid_token`.
   */
  retry?:
    | false
    | {
        /** 1 to 3, and 3 where absent. Outside that range it is `InvalidOption`. */
        maxAttempts?: number;
      };
  /**
   * How a stream that fills more than one part is uploaded: as one resumable session, its
   * parts sent as chunks one after another. A stream that ends within one part goes as a
   * single request.
   */
  multipart?: {
    /**
     * Bytes per part, a multiple of 256 KiB from 256 KiB to 5 GiB, and 8 MiB where absent.
     * Anything else is `InvalidOption` and is not clamped: GCS takes a chunk other than the
     * last in multiples of 256 KiB alone. The chunks go one after another, so there is no
     * `concurrency`, and a streamed `put` holds one part in memory.
     */
    partSize?: number;
  };
}

/** The options as the storage holds them, every default filled in and nothing to refuse. */
export interface GcsConfiguration {
  readonly bucket: string;
  /** Scheme and host, port included, which every request is addressed to. */
  readonly origin: string;
  /** What the endpoint puts in front of the path, as it stands before encoding. */
  readonly basePath: string;
  readonly credentials: Resolvable<GcsCredentials>;
  readonly signer?: GcsSigner;
  readonly maxAttempts: number;
  readonly partSize: number;
}

const adapterOptionKeys: readonly string[] = [
  "bucket",
  "endpoint",
  "credentials",
  "signer",
  "retry",
  "multipart",
];
const multipartOptionKeys: readonly string[] = ["partSize"];
const signerFields: ReadonlySet<string> = new Set(["serviceAccount", "privateKey", "credentials"]);

const kibibyte = 1024;
const mebibyte = 1024 * kibibyte;
const gibibyte = 1024 * mebibyte;

/** GCS takes a resumable chunk other than the last in multiples of this alone. */
const chunkGranularity = 256 * kibibyte;

const defaultEndpoint = "https://storage.googleapis.com";
const defaultPartSize = 8 * mebibyte;

const partSizeRange = { least: chunkGranularity, most: 5 * gibibyte };

/**
 * IPv4 loopback is the whole `127.0.0.0/8` block and IPv6 loopback the single `::1`.
 * `localhost` stands beside them because RFC 6761 binds the name to one of the two, which
 * is what makes it an address spec 9.1 accepts rather than a host that might be anywhere.
 */
const loopbackHosts = /^(?:localhost|127(?:\.\d{1,3}){3}|\[::1\])$/u;

/**
 * Spec 9.1: every option is validated where the storage is constructed, an unknown key
 * and a value outside its range are `InvalidOption` naming the key, and no value is
 * clamped onto the range it missed.
 */
export function readConfiguration(options: GcsAdapterOptions): GcsConfiguration {
  const bucket = typeof options.bucket === "string" ? options.bucket : "";

  requireKnownOptions(bucket, options, adapterOptionKeys, "gcsStorage");
  requireFilled(bucket, options.bucket, "bucket");

  if (options.credentials === undefined) {
    throw optionError(bucket, "credentials", "is required: no request goes out without a token");
  }

  return {
    bucket: options.bucket,
    ...readEndpoint(bucket, options.endpoint),
    credentials: options.credentials,
    ...(options.signer === undefined ? {} : { signer: readSigner(bucket, options.signer) }),
    maxAttempts: readMaxAttempts(options.retry, {
      provider: "gcs",
      bucket: bucket,
      constructedBy: "gcsStorage",
    }),
    partSize: readPartSize(bucket, options.multipart),
  };
}

/**
 * Spec 9.1 takes the endpoint rules of spec 7.1: no endpoint addresses the public
 * service, a configured one is an absolute URL without userinfo, query and fragment, and
 * `http:` is accepted for a loopback host alone. Its path is kept as the prefix of every
 * request path.
 */
function readEndpoint(
  bucket: string,
  endpoint: string | undefined,
): { origin: string; basePath: string } {
  if (endpoint === undefined) return { origin: defaultEndpoint, basePath: "" };

  if (typeof endpoint !== "string") throw optionError(bucket, "endpoint", "is no absolute URL");

  const parsed = URL.parse(endpoint);

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
    origin: `${parsed.protocol}//${parsed.host}`,
    basePath: readBasePath(bucket, parsed.pathname.replace(/\/$/u, "")),
  };
}

/**
 * The path as it stands before encoding: `URL` hands it back percent-encoded, and every
 * request path is encoded once on its way out, the prefix included.
 */
function readBasePath(bucket: string, pathname: string): string {
  try {
    return pathname.split("/").map(decodeURIComponent).join("/");
  } catch {
    throw optionError(bucket, "endpoint", "holds a malformed escape in its path");
  }
}

function isLoopbackHttp(endpoint: URL): boolean {
  return endpoint.protocol === "http:" && loopbackHosts.test(endpoint.hostname);
}

/**
 * Spec 9.1: a non-empty `serviceAccount` and exactly one of the two ways to sign. The
 * signer's fields are named under `signer.`, since `credentials` would otherwise read as
 * the storage's own.
 */
function readSigner(bucket: string, signer: GcsSigner): GcsSigner {
  requireGroup(bucket, signer, "signer");

  const unknown = Object.keys(signer).find((field) => !signerFields.has(field));

  if (unknown !== undefined) {
    throw optionError(bucket, `signer.${unknown}`, "is not one a signer takes");
  }

  if (typeof signer.serviceAccount !== "string" || signer.serviceAccount === "") {
    throw optionError(bucket, "signer.serviceAccount", "takes a non-empty string");
  }

  const privateKey = "privateKey" in signer ? signer.privateKey : undefined;
  const credentials = "credentials" in signer ? signer.credentials : undefined;

  if ((privateKey === undefined) === (credentials === undefined)) {
    throw optionError(bucket, "signer", "holds exactly one of `privateKey` and `credentials`");
  }

  if (privateKey !== undefined && !isPrivateKeySource(privateKey)) {
    throw optionError(
      bucket,
      "signer.privateKey",
      "takes a non-empty PEM, a `CryptoKey` or a resolver",
    );
  }

  if (credentials !== undefined && !isCredentialsSource(credentials)) {
    throw optionError(bucket, "signer.credentials", "takes a credential or a resolver");
  }

  return signer;
}

// The contents are checked where they are resolved, on every call (spec 9.9); here only
// the shape that decides whether anything can be resolved at all.
function isPrivateKeySource(value: unknown): boolean {
  if (typeof value === "string") return value !== "";

  return typeof value === "function" || (typeof value === "object" && value !== null);
}

function isCredentialsSource(value: unknown): boolean {
  return typeof value === "function" || (typeof value === "object" && value !== null);
}

function readPartSize(bucket: string, multipart: GcsAdapterOptions["multipart"]): number {
  if (multipart === undefined) return defaultPartSize;

  requireGroup(bucket, multipart, "multipart");
  requireKnownOptions(bucket, multipart, multipartOptionKeys, "gcsStorage");

  const partSize = readInRange(
    bucket,
    multipart.partSize,
    "partSize",
    partSizeRange,
    defaultPartSize,
  );

  if (partSize % chunkGranularity !== 0) {
    throw optionError(bucket, "partSize", "takes the multiples of 256 KiB alone");
  }

  return partSize;
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

/**
 * A group of options is an object. Without this, `Object.keys` reads `retry: true` as a
 * group with no key and hands back the default, and `retry: null` throws a `TypeError`
 * where spec 9.1 asks for `InvalidOption`.
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
// 9.1 has the configuration read.
function optionError(bucket: string, option: string, expectation: string): StorageError {
  return refuseOption(bucket, option, expectation, "gcsStorage");
}
