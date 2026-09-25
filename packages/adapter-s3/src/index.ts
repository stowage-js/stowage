import {
  type CapabilityName,
  type DeleteReport,
  type GetOptions,
  isStorageError,
  type ListOptions,
  type ObjectListing,
  type ObjectStat,
  type OperationOptions,
  type PresignedPut,
  type PutBody,
  type PutOptions,
  type Storage,
  type StoredObject,
} from "@stowage/core";

import { readConfiguration, type S3AdapterOptions, type S3Configuration } from "./configuration.ts";
import { copyObject } from "./copy.ts";
import { deleteBelow, deleteKeys } from "./delete.ts";
import { defaultContentType, describeResponse } from "./description.ts";
import { requireKey } from "./key.ts";
import { createListing } from "./listing.ts";
import {
  presignGet,
  presignPut,
  type S3PresignGetOptions,
  type S3PresignPutOptions,
} from "./presign.ts";
import {
  getOptionKeys,
  operationOptionKeys,
  optionError,
  putOptionKeys,
  requireKnownOptions,
} from "./options.ts";
import { send } from "./request.ts";
import { partialContent, rangeHeader, requireRange, wholeAnswerFailure } from "./range.ts";
import { s3Error } from "./storage-error.ts";
import { createStoredObject } from "./stored-object.ts";
import { type ObjectWrite, putObject, uploadStream } from "./upload.ts";
import { userMetadataHeaders } from "./user-metadata.ts";

export type { S3AdapterOptions } from "./configuration.ts";
export { fromEnv, type S3Credentials } from "./credentials.ts";
export type { S3PresignGetOptions, S3PresignPutOptions } from "./presign.ts";

export interface S3Storage extends Storage {
  readonly provider: "s3";
  /**
   * Sends at most one `DeleteObjects` per 1000 keys, plus at most one `DELETE` per key
   * holding `U+FFFE` or `U+FFFF`, which XML carries neither raw nor as a reference. Those
   * go after the batches, one after another.
   */
  delete(...keys: readonly string[]): Promise<DeleteReport>;
  /**
   * A URL a client holding no credential calls with a plain `GET` for this one key until
   * it expires. Whoever holds it may read the object: it is a bearer token. Sends no
   * request, and works against the endpoint that signed it only.
   */
  presignGet(key: string, options: S3PresignGetOptions): Promise<string>;
  /**
   * A URL a client holding no credential calls with a plain `PUT` of one body under this
   * key until it expires. `contentType` and `contentLength` bind exactly: the provider
   * refuses a body of another type or another length, so a body of unknown length cannot
   * be uploaded through it. It signs `UNSIGNED-PAYLOAD` and no checksum, so the upload
   * carries no integrity check. Resolves with the URL and the `content-type` the `PUT`
   * sends beside the body. Sends no request.
   */
  presignPut(key: string, options: S3PresignPutOptions): Promise<PresignedPut>;
}

export function s3Storage(options: S3AdapterOptions): S3Storage {
  return new SimpleStorageServiceStorage(options);
}

/** Spec 7.1, in the order `capabilityNames` of spec 4.9 lists the names. */
const s3Capabilities: readonly CapabilityName[] = Object.freeze([
  "presignedUrls",
  "rangeReads",
  "userMetadata",
  "userMetadataTokenKeys",
]);

const utf8 = new TextEncoder();

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
    try {
      return await this.#put(key, body, options);
    } catch (failure) {
      // Spec 4.2 leaves the stream at its end or canceled once `put` settled, which for a
      // refusal in front of the upload is this cancel and for a failed upload its own.
      if (isStream(body) && !body.locked) await body.cancel(failure).catch(() => {});

      throw failure;
    }
  }

  async #put(key: string, body: PutBody, options?: PutOptions): Promise<ObjectStat> {
    requireKey(this.bucket, key, "writable", "put");
    requireKnownOptions(this.bucket, options, putOptionKeys, "put");

    const write: ObjectWrite = {
      key,
      userMetadata: userMetadataHeaders(this.bucket, options?.userMetadata, key, this.capabilities),
      contentType: this.#readContentType(options?.contentType),
      signal: options?.signal,
    };

    // Spec 4.3: a signal that already fired rejects before the request goes out.
    options?.signal?.throwIfAborted();

    if (isStream(body)) return await uploadStream(this.#configuration, write, body);

    return await putObject(this.#configuration, write, bytesOf(body));
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

    const refusal =
      range === undefined || response.status === partialContent
        ? undefined
        : wholeAnswerFailure(this.bucket, key, range, stat.size);

    if (refusal !== undefined) {
      await response.body?.cancel();

      throw refusal;
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
    this.#requireCopyKeys(from, to, options, "copy");

    return await copyObject(this.#configuration, from, to, "copy", options?.signal);
  }

  /**
   * Spec 4.10: `copy`, then the source deleted, each failure told as `move`'s. The
   * destination is described before the source goes, so a failing delete leaves both in
   * place and a repeated `move` is safe.
   */
  async move(from: string, to: string, options?: OperationOptions): Promise<ObjectStat> {
    this.#requireCopyKeys(from, to, options, "move");

    const written = await copyObject(this.#configuration, from, to, "move", options?.signal);
    const response = await send(this.#configuration, {
      method: "DELETE",
      operation: "move",
      key: from,
      signal: options?.signal,
    });

    await response.body?.cancel();

    return written;
  }

  async presignGet(key: string, options: S3PresignGetOptions): Promise<string> {
    return await presignGet(this.#configuration, key, options);
  }

  async presignPut(key: string, options: S3PresignPutOptions): Promise<PresignedPut> {
    return await presignPut(this.#configuration, key, options);
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

  /**
   * Spec 4.8 checks both keys before acting on either, and spec 7.8 has a copy of a key
   * onto itself stop before it leaves the process; a `move` onto itself would otherwise
   * delete the one object it named.
   */
  #requireCopyKeys(
    from: string,
    to: string,
    options: OperationOptions | undefined,
    operation: string,
  ): void {
    requireKey(this.bucket, from, "addressable", operation);
    requireKey(this.bucket, to, "writable", operation);
    requireKnownOptions(this.bucket, options, operationOptionKeys, operation);

    if (from !== to) return;

    throw s3Error(this.bucket, {
      code: "InvalidRequest",
      message: "A copy names one key as its source and another as its destination",
      operation,
      key: from,
      attempts: 0,
    });
  }

  #readContentType(contentType: string | undefined): string {
    if (contentType === undefined) return defaultContentType;

    if (typeof contentType !== "string" || contentType === "") {
      throw optionError(this.bucket, "contentType", "takes a non-empty string", "put");
    }

    return contentType;
  }
}

/** Spec 4.2: a string travels as its UTF-8 bytes. */
function bytesOf(body: string | Uint8Array): Uint8Array<ArrayBuffer> {
  return typeof body === "string" ? utf8.encode(body) : heldBytes(body);
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

function isStream(body: PutBody): body is ReadableStream<Uint8Array> {
  return typeof body !== "string" && !(body instanceof Uint8Array);
}
