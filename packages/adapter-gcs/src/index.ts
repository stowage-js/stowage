import {
  type CapabilityName,
  type DeleteReport,
  type GetOptions,
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

import {
  type GcsAdapterOptions,
  type GcsConfiguration,
  type GcsSigner,
  readConfiguration,
} from "./configuration.ts";
import { deleteBelow, deleteKeys } from "./delete.ts";
import { defaultContentType, readDescription } from "./description.ts";
import { getObject } from "./download.ts";
import { requireKey } from "./key.ts";
import { createListing } from "./listing.ts";
import {
  getOptionKeys,
  operationOptionKeys,
  optionError,
  putOptionKeys,
  requireKnownOptions,
} from "./options.ts";
import {
  type GcsPresignGetOptions,
  type GcsPresignPutOptions,
  presignGet,
  presignPut,
} from "./presign.ts";
import { requireRange } from "./range.ts";
import { gcsError, isMissingObject } from "./storage-error.ts";
import { putBytes } from "./upload.ts";
import { heldUserMetadata } from "./user-metadata.ts";

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
    : new GcsSigningBucketStorage(configuration, configuration.signer);
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

    const userMetadata = heldUserMetadata(
      this.bucket,
      options?.userMetadata,
      key,
      this.capabilities,
    );
    const contentType = this.#readContentType(options?.contentType);

    // Spec 4.3: a signal that already fired rejects before the request goes out.
    options?.signal?.throwIfAborted();

    if (isStream(body)) throw notYetImplemented("`put` of a stream");

    return await putBytes(
      this.configuration,
      { key, contentType, userMetadata, signal: options?.signal },
      bytesOf(body),
    );
  }

  async get(key: string, options?: GetOptions): Promise<StoredObject> {
    requireKey(this.bucket, key, "addressable", "get");
    requireKnownOptions(this.bucket, options, getOptionKeys, "get");
    requireRange(this.bucket, options?.range);

    options?.signal?.throwIfAborted();

    return await getObject(this.configuration, key, options?.range, options?.signal);
  }

  async stat(key: string, options?: OperationOptions): Promise<ObjectStat> {
    this.#requireAddressable(key, options, "stat");

    return await readDescription(this.configuration, key, "stat", options?.signal);
  }

  async exists(key: string, options?: OperationOptions): Promise<boolean> {
    this.#requireAddressable(key, options, "exists");

    try {
      await readDescription(this.configuration, key, "exists", options?.signal);

      return true;
    } catch (failure) {
      // Spec 4.10: `exists` answers `false` for `NotFound` alone and rethrows the rest,
      // a missing bucket among them.
      if (isMissingObject(failure)) return false;

      throw failure;
    }
  }

  list(options?: ListOptions): ObjectListing {
    return createListing(this.configuration, options);
  }

  async delete(...keys: readonly string[]): Promise<DeleteReport> {
    return await deleteKeys(this.configuration, keys, { operation: "delete" });
  }

  async deleteAll(prefix: string, options?: OperationOptions): Promise<DeleteReport> {
    requireKey(this.bucket, prefix, "prefix", "deleteAll");
    requireKnownOptions(this.bucket, options, operationOptionKeys, "deleteAll");

    // Spec 4.3: a signal that already fired rejects before the request goes out.
    options?.signal?.throwIfAborted();

    return await deleteBelow(this.configuration, prefix, options?.signal);
  }

  async copy(from: string, to: string, options?: OperationOptions): Promise<ObjectStat> {
    this.#requireCopyKeys(from, to, options, "copy");

    throw notYetImplemented("`copy`");
  }

  async move(from: string, to: string, options?: OperationOptions): Promise<ObjectStat> {
    this.#requireCopyKeys(from, to, options, "move");

    throw notYetImplemented("`move`");
  }

  #requireAddressable(key: string, options: OperationOptions | undefined, operation: string): void {
    requireKey(this.bucket, key, "addressable", operation);
    requireKnownOptions(this.bucket, options, operationOptionKeys, operation);

    options?.signal?.throwIfAborted();
  }

  /**
   * Spec 4.8 checks both keys before acting on either, and spec 9.7 has a copy of a key
   * onto itself refused before any request.
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

    throw gcsError(this.bucket, {
      code: "InvalidRequest",
      message: "A copy names one key as its source and another as its destination",
      operation,
      key: from,
      attempts: 0,
    });
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

  readonly #signer: GcsSigner;

  constructor(configuration: GcsConfiguration, signer: GcsSigner) {
    super(configuration);
    this.#signer = signer;
  }

  async presignGet(key: string, options: GcsPresignGetOptions): Promise<string> {
    return await presignGet(this.configuration, this.#signer, key, options);
  }

  async presignPut(key: string, options: GcsPresignPutOptions): Promise<PresignedPut> {
    return await presignPut(this.configuration, this.#signer, key, options);
  }
}

/**
 * The package is unreleased while its operations arrive one by one, and a call that
 * reaches one still missing says so rather than pretending to a failure of the provider.
 */
function notYetImplemented(what: string): Error {
  return new Error(`${what} is not implemented in adapter-gcs yet`);
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
