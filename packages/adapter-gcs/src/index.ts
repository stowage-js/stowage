import {
  type CapabilityName,
  type DeleteReport,
  type GetOptions,
  isStorageError,
  type ObjectListing,
  type ObjectStat,
  type OperationOptions,
  type PresignedPut,
  type PutBody,
  type PutOptions,
  type Storage,
  type StoredObject,
} from "@stowage/core";

import {
  type GcsAdapterOptions,
  type GcsConfiguration,
  type GcsSigner,
  readConfiguration,
} from "./configuration.ts";
import { defaultContentType, describeResource, readResource } from "./description.ts";
import { requireKey } from "./key.ts";
import {
  getOptionKeys,
  operationOptionKeys,
  optionError,
  putOptionKeys,
  requireKnownOptions,
} from "./options.ts";
import type { GcsPresignGetOptions, GcsPresignPutOptions } from "./presign.ts";
import { objectPath, send } from "./request.ts";
import { createStoredObject } from "./stored-object.ts";
import { putBytes } from "./upload.ts";

export type { GcsAdapterOptions, GcsSigner } from "./configuration.ts";
export type { GcsCredentials } from "./credentials.ts";
export type { GcsPresignGetOptions, GcsPresignPutOptions } from "./presign.ts";

export interface GcsStorage extends Storage {
  readonly provider: "gcs";
}

export interface GcsSigningStorage extends GcsStorage {
  presignGet(key: string, options: GcsPresignGetOptions): Promise<string>;
  presignPut(key: string, options: GcsPresignPutOptions): Promise<PresignedPut>;
}

/**
 * Overloaded on `signer`, the option that decides `presignedUrls`: with one the storage
 * carries `presignGet` and `presignPut`, and without one it carries neither, at runtime as
 * on the type (ADR 0035).
 */
export function gcsStorage(options: GcsAdapterOptions & { signer: GcsSigner }): GcsSigningStorage;
export function gcsStorage(options: GcsAdapterOptions): GcsStorage;
export function gcsStorage(options: GcsAdapterOptions): GcsStorage {
  const configuration = readConfiguration(options);

  return configuration.signer === undefined
    ? new GcsBucketStorage(configuration)
    : new GcsSigningBucketStorage(configuration);
}

// Spec 9.1 and ADR 0032, in the order of `capabilityNames`.
const gcsCapabilities: readonly CapabilityName[] = Object.freeze([
  "keyBytesPreserved",
  "rangeReads",
  "userMetadata",
  "userMetadataTokenKeys",
]);
const gcsSigningCapabilities: readonly CapabilityName[] = Object.freeze([
  "keyBytesPreserved",
  "presignedUrls",
  "rangeReads",
  "userMetadata",
  "userMetadataTokenKeys",
]);

const utf8 = new TextEncoder();

class GcsBucketStorage implements GcsStorage {
  readonly provider = "gcs" as const;
  readonly bucket: string;
  readonly capabilities: readonly CapabilityName[] = gcsCapabilities;

  protected readonly configuration: GcsConfiguration;

  constructor(configuration: GcsConfiguration) {
    this.configuration = configuration;
    this.bucket = configuration.bucket;
  }

  async put(key: string, body: PutBody, options?: PutOptions): Promise<ObjectStat> {
    try {
      return await this.#put(key, body, options);
    } catch (failure) {
      // Spec 4.2 leaves the stream at its end or canceled once `put` settled.
      if (isStream(body) && !body.locked) await body.cancel(failure).catch(() => {});

      throw failure;
    }
  }

  async #put(key: string, body: PutBody, options?: PutOptions): Promise<ObjectStat> {
    requireKey(this.bucket, key, "writable", "put");
    requireKnownOptions(this.bucket, options, putOptionKeys, "put");

    if (options?.userMetadata !== undefined && Object.keys(options.userMetadata).length > 0) {
      throw notYetImplemented("`put` with user metadata");
    }

    const contentType = this.#readContentType(options?.contentType);

    // Spec 4.3: a signal that already fired rejects before the request goes out.
    options?.signal?.throwIfAborted();

    if (isStream(body)) throw notYetImplemented("`put` of a stream");

    return await putBytes(
      this.configuration,
      { key, contentType, signal: options?.signal },
      bytesOf(body),
    );
  }

  /**
   * Spec 9.4: the resource request and the media download side by side, since the media
   * download carries no user metadata. Where the resource request fails its failure is
   * reported, and a failure of the download only where the resource succeeded; either
   * failure aborts the other request (spec 9.8).
   */
  async get(key: string, options?: GetOptions): Promise<StoredObject> {
    requireKey(this.bucket, key, "addressable", "get");
    requireKnownOptions(this.bucket, options, getOptionKeys, "get");

    if (options?.range !== undefined) throw notYetImplemented("`get` of a range");

    options?.signal?.throwIfAborted();

    const abortPair = new AbortController();
    const signal =
      options?.signal === undefined
        ? abortPair.signal
        : AbortSignal.any([options.signal, abortPair.signal]);
    const abortOther = (failure: unknown): never => {
      abortPair.abort();

      throw failure;
    };
    const [described, download] = await Promise.allSettled([
      this.#readResource(key, "get", signal).catch(abortOther),
      send(this.configuration, {
        method: "GET",
        operation: "get",
        key,
        path: objectPath(this.configuration, key),
        query: [["alt", "media"]],
        signal,
      }).catch(abortOther),
    ]);

    if (described.status === "rejected") {
      if (download.status === "fulfilled") await download.value.body?.cancel();

      // The resource request was aborted because the download failed first, and not by
      // the caller, so the download's failure is the one to report.
      if (
        download.status === "rejected" &&
        isAbortNotFromCaller(described.reason, options?.signal)
      ) {
        throw download.reason;
      }

      throw described.reason;
    }

    if (download.status === "rejected") throw download.reason;

    return createStoredObject(this.bucket, described.value, download.value);
  }

  async stat(key: string, options?: OperationOptions): Promise<ObjectStat> {
    this.#requireAddressable(key, options, "stat");

    return await this.#readResource(key, "stat", options?.signal);
  }

  async exists(key: string, options?: OperationOptions): Promise<boolean> {
    this.#requireAddressable(key, options, "exists");

    try {
      await this.#readResource(key, "exists", options?.signal);

      return true;
    } catch (failure) {
      // Spec 4.10: `exists` answers `false` for `NotFound` alone and rethrows the rest.
      if (isStorageError(failure) && failure.code === "NotFound") return false;

      throw failure;
    }
  }

  list(): ObjectListing {
    throw notYetImplemented("`list`");
  }

  async delete(): Promise<DeleteReport> {
    throw notYetImplemented("`delete`");
  }

  async deleteAll(): Promise<DeleteReport> {
    throw notYetImplemented("`deleteAll`");
  }

  async copy(): Promise<ObjectStat> {
    throw notYetImplemented("`copy`");
  }

  async move(): Promise<ObjectStat> {
    throw notYetImplemented("`move`");
  }

  /** The object's resource, which spec 9.4 has `stat`, `exists` and `get` describe it by. */
  async #readResource(key: string, operation: string, signal?: AbortSignal): Promise<ObjectStat> {
    const response = await send(this.configuration, {
      method: "GET",
      operation,
      key,
      path: objectPath(this.configuration, key),
      signal,
    });
    const resource = await readResource(this.bucket, key, operation, response);

    return describeResource(this.bucket, key, operation, response, resource);
  }

  #requireAddressable(key: string, options: OperationOptions | undefined, operation: string): void {
    requireKey(this.bucket, key, "addressable", operation);
    requireKnownOptions(this.bucket, options, operationOptionKeys, operation);

    options?.signal?.throwIfAborted();
  }

  #readContentType(contentType: string | undefined): string {
    if (contentType === undefined) return defaultContentType;

    if (
      typeof contentType !== "string" ||
      contentType === "" ||
      holdsControlCharacter(contentType)
    ) {
      throw optionError(
        this.bucket,
        "contentType",
        "takes a non-empty string without control characters",
        "put",
      );
    }

    return contentType;
  }
}

class GcsSigningBucketStorage extends GcsBucketStorage implements GcsSigningStorage {
  override readonly capabilities: readonly CapabilityName[] = gcsSigningCapabilities;

  async presignGet(): Promise<string> {
    throw notYetImplemented("`presignGet`");
  }

  async presignPut(): Promise<PresignedPut> {
    throw notYetImplemented("`presignPut`");
  }
}

/**
 * The package is unreleased while its operations arrive one by one, and a call that
 * reaches one still missing says so rather than pretending to a failure of the provider.
 */
function notYetImplemented(what: string): Error {
  return new Error(`${what} is not implemented in adapter-gcs yet`);
}

function isAbortNotFromCaller(failure: unknown, callerSignal: AbortSignal | undefined): boolean {
  return (
    failure instanceof Error && failure.name === "AbortError" && callerSignal?.aborted !== true
  );
}

/**
 * A control character would end the head of the media part the content type is written
 * into. A tab stays, since a header value may hold one.
 */
function holdsControlCharacter(value: string): boolean {
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);

    if ((code <= 0x1f && code !== 0x09) || code === 0x7f) return true;
  }

  return false;
}

/** Spec 4.2: a string travels as its UTF-8 bytes. */
function bytesOf(body: string | Uint8Array): Uint8Array<ArrayBuffer> {
  return typeof body === "string" ? utf8.encode(body) : heldBytes(body);
}

/**
 * The same bytes as a view the body is assembled from: a view on a `SharedArrayBuffer` is
 * the one body copied rather than read where it lies.
 */
function heldBytes(body: Uint8Array): Uint8Array<ArrayBuffer> {
  const { buffer } = body;

  if (buffer instanceof ArrayBuffer) {
    return new Uint8Array(buffer, body.byteOffset, body.byteLength);
  }

  return new Uint8Array(body);
}

function isStream(body: PutBody): body is ReadableStream<Uint8Array> {
  return typeof body !== "string" && !(body instanceof Uint8Array);
}
