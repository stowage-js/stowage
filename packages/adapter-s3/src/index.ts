import {
  type CapabilityName,
  type DeleteReport,
  type GetOptions,
  isStorageError,
  type ListOptions,
  type ObjectListing,
  type ObjectStat,
  type OperationOptions,
  type PutBody,
  type PutOptions,
  type Storage,
  type StoredObject,
} from "@stowage/core";

import { readConfiguration, type S3AdapterOptions, type S3Configuration } from "./configuration.ts";
import { deleteBelow, deleteKeys } from "./delete.ts";
import { defaultContentType, describeResponse, describeWrite } from "./description.ts";
import { requireKey } from "./key.ts";
import { createListing } from "./listing.ts";
import {
  getOptionKeys,
  operationOptionKeys,
  optionError,
  putOptionKeys,
  requireKnownOptions,
} from "./options.ts";
import { send } from "./request.ts";
import { rangeHeader, requireRange, wholeObjectFailure } from "./range.ts";
import { s3Error } from "./storage-error.ts";
import { createStoredObject } from "./stored-object.ts";
import { userMetadataHeaders } from "./user-metadata.ts";

export type { S3AdapterOptions } from "./configuration.ts";
export { fromEnv, type S3Credentials } from "./credentials.ts";

export interface S3Storage extends Storage {
  readonly provider: "s3";
}

export function s3Storage(options: S3AdapterOptions): S3Storage {
  return new SimpleStorageServiceStorage(options);
}

/**
 * Spec 7.1 has this storage declare `presignedUrls`, `rangeReads` and `userMetadata`.
 * Each is declared where it is built, so that what the storage names is what the
 * conformance suite finds: `presignedUrls` arrives with `presignGet` and `presignPut`.
 */
const s3Capabilities: readonly CapabilityName[] = Object.freeze(["rangeReads", "userMetadata"]);

const utf8 = new TextEncoder();

const partialContent = 206;

class SimpleStorageServiceStorage implements S3Storage {
  readonly provider = "s3" as const;
  readonly bucket: string;
  readonly capabilities: readonly CapabilityName[] = s3Capabilities;

  readonly #configuration: S3Configuration;

  constructor(options: S3AdapterOptions) {
    this.#configuration = readConfiguration(options);
    this.bucket = this.#configuration.bucket;
  }

  async put(key: string, body: PutBody, options?: PutOptions): Promise<ObjectStat> {
    requireKey(this.bucket, key, "writable", "put");
    requireKnownOptions(this.bucket, options, putOptionKeys, "put");

    const userMetadata = userMetadataHeaders(this.bucket, options?.userMetadata, key);
    const contentType = this.#readContentType(options?.contentType);
    const bytes = this.#holdBody(body);

    // Spec 4.3: a signal that already fired rejects before the request goes out.
    options?.signal?.throwIfAborted();

    const response = await send(this.#configuration, {
      method: "PUT",
      operation: "put",
      key,
      headers: [["content-type", contentType], ...userMetadata.headers],
      body: bytes,
      signal: options?.signal,
    });

    await response.body?.cancel();

    return describeWrite(
      this.bucket,
      key,
      bytes.byteLength,
      contentType,
      userMetadata.held,
      response,
    );
  }

  async get(key: string, options?: GetOptions): Promise<StoredObject> {
    requireKey(this.bucket, key, "addressable", "get");
    requireKnownOptions(this.bucket, options, getOptionKeys, "get");

    const range = options?.range;

    requireRange(this.bucket, range);

    options?.signal?.throwIfAborted();

    const response = await send(this.#configuration, {
      method: "GET",
      operation: "get",
      key,
      headers: range === undefined ? [] : [["range", rangeHeader(range)]],
      signal: options?.signal,
    });
    const stat = describeResponse(this.bucket, key, "get", response);

    if (range !== undefined && response.status !== partialContent) {
      await response.body?.cancel();

      throw wholeObjectFailure(this.bucket, key, range, stat.size);
    }

    return createStoredObject(this.bucket, stat, response);
  }

  async stat(key: string, options?: OperationOptions): Promise<ObjectStat> {
    return describeResponse(this.bucket, key, "stat", await this.#head(key, "stat", options));
  }

  async exists(key: string, options?: OperationOptions): Promise<boolean> {
    try {
      await this.#head(key, "exists", options);

      return true;
    } catch (failure) {
      // Spec 4.10: `exists` answers `false` for `NotFound` alone and rethrows the rest,
      // including the `403` a credential without `s3:ListBucket` meets for a missing key.
      if (isStorageError(failure) && failure.code === "NotFound") return false;

      throw failure;
    }
  }

  list(options?: ListOptions): ObjectListing {
    return createListing(this.#configuration, options);
  }

  async delete(...keys: readonly string[]): Promise<DeleteReport> {
    return await deleteKeys(this.#configuration, keys, { operation: "delete" });
  }

  async deleteAll(prefix: string, options?: OperationOptions): Promise<DeleteReport> {
    requireKey(this.bucket, prefix, "prefix", "deleteAll");
    requireKnownOptions(this.bucket, options, operationOptionKeys, "deleteAll");

    options?.signal?.throwIfAborted();

    return await deleteBelow(this.#configuration, prefix, options?.signal);
  }

  async copy(from: string, to: string, options?: OperationOptions): Promise<ObjectStat> {
    requireKey(this.bucket, from, "addressable", "copy");
    requireKey(this.bucket, to, "writable", "copy");
    requireKnownOptions(this.bucket, options, operationOptionKeys, "copy");
    this.#requireDistinct(from, to);

    throw notBuiltYet("copy");
  }

  async move(from: string, to: string, options?: OperationOptions): Promise<ObjectStat> {
    void from;
    void to;
    void options;

    throw notBuiltYet("move");
  }

  async #head(key: string, operation: string, options?: OperationOptions): Promise<Response> {
    requireKey(this.bucket, key, "addressable", operation);
    requireKnownOptions(this.bucket, options, operationOptionKeys, operation);

    options?.signal?.throwIfAborted();

    return await send(this.#configuration, {
      method: "HEAD",
      operation,
      key,
      signal: options?.signal,
    });
  }

  /** Spec 7.8: a copy of a key onto itself stores nothing and never leaves the process. */
  #requireDistinct(from: string, to: string): void {
    if (from !== to) return;

    throw s3Error(this.bucket, {
      code: "InvalidRequest",
      message: "A copy names one key as its source and another as its destination",
      operation: "copy",
      key: from,
      attempts: 0,
    });
  }

  /** Spec 4.2: a string travels as its UTF-8 bytes, and a stream as buffered parts. */
  #holdBody(body: PutBody): Uint8Array<ArrayBuffer> {
    if (typeof body === "string") return utf8.encode(body);
    if (body instanceof Uint8Array) return heldBytes(body);

    throw notBuiltYet("put of a stream");
  }

  #readContentType(contentType: string | undefined): string {
    if (contentType === undefined) return defaultContentType;

    if (typeof contentType !== "string" || contentType === "") {
      throw optionError(this.bucket, "contentType", "takes a non-empty string", "put");
    }

    return contentType;
  }
}

/**
 * The same bytes as a view Web Crypto takes: `BufferSource` rules out a view on a
 * `SharedArrayBuffer`, which is the one body copied rather than hashed and sent where it
 * lies. ADR 0009 already spends the memory of holding a body whole, and a copy of every
 * one of them would spend it twice.
 */
function heldBytes(body: Uint8Array): Uint8Array<ArrayBuffer> {
  const { buffer } = body;

  if (buffer instanceof ArrayBuffer) {
    return new Uint8Array(buffer, body.byteOffset, body.byteLength);
  }

  return new Uint8Array(body);
}

function notBuiltYet(operation: string): Error {
  return new Error(`\`${operation}\` is not implemented in @stowage/adapter-s3 yet`);
}
