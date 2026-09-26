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

import {
  type AzureBlobAdapterOptions,
  type AzureBlobConfiguration,
  readConfiguration,
} from "./configuration.ts";
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
import { rangeAnswerFailure, rangeHeader, requireRange } from "./range.ts";
import { send } from "./request.ts";
import { azureBlobError } from "./storage-error.ts";
import { createStoredObject } from "./stored-object.ts";

export type { AzureBlobAdapterOptions } from "./configuration.ts";
export { type AzureBlobCredentials, fromEnv } from "./credentials.ts";

export interface AzureBlobStorage extends Storage {
  readonly provider: "azure-blob";
}

export function azureBlobStorage(options: AzureBlobAdapterOptions): AzureBlobStorage {
  return new AzureBlobContainerStorage(options);
}

const azureBlobCapabilities: readonly CapabilityName[] = Object.freeze(["rangeReads"]);

const utf8 = new TextEncoder();

class AzureBlobContainerStorage implements AzureBlobStorage {
  readonly provider = "azure-blob" as const;
  readonly bucket: string;
  readonly capabilities: readonly CapabilityName[] = azureBlobCapabilities;

  readonly #configuration: AzureBlobConfiguration;

  constructor(options: AzureBlobAdapterOptions) {
    this.#configuration = readConfiguration(options);
    this.bucket = this.#configuration.container;
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
    this.#requireNoUserMetadata(options?.userMetadata, key);

    const contentType = this.#readContentType(options?.contentType);

    // Spec 4.3: a signal that already fired rejects before the request goes out.
    options?.signal?.throwIfAborted();

    if (isStream(body)) throw notYetImplemented("`put` of a stream");

    const bytes = bytesOf(body);
    const response = await send(this.#configuration, {
      method: "PUT",
      operation: "put",
      key,
      headers: [
        ["content-type", contentType],
        ["x-ms-blob-type", "BlockBlob"],
      ],
      body: bytes,
      signal: options?.signal,
    });

    await response.body?.cancel();

    return describeWrite(this.bucket, key, bytes.byteLength, contentType, response);
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
      range === undefined
        ? undefined
        : rangeAnswerFailure(this.bucket, key, range, response, stat.size);

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
      // Spec 4.10: `exists` answers `false` for `NotFound` alone and rethrows the rest.
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

    throw notYetImplemented("`copy`");
  }

  async move(from: string, to: string, options?: OperationOptions): Promise<ObjectStat> {
    this.#requireCopyKeys(from, to, options, "move");

    throw notYetImplemented("`move`");
  }

  /** `Get Blob Properties`, whose failure spec 8.4 reads the code off `x-ms-error-code`. */
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
   * Spec 4.8 checks both keys before acting on either, and spec 8.7 has a copy of a key
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

    throw azureBlobError(this.bucket, {
      code: "InvalidRequest",
      message: "A copy names one key as its source and another as its destination",
      operation,
      key: from,
      attempts: 0,
    });
  }

  #requireNoUserMetadata(userMetadata: Record<string, string> | undefined, key: string): void {
    if (userMetadata === undefined || Object.keys(userMetadata).length === 0) return;

    throw this.#unsupported("userMetadata", "This storage holds no user metadata", "put", key);
  }

  #readContentType(contentType: string | undefined): string {
    if (contentType === undefined) return defaultContentType;

    if (typeof contentType !== "string" || contentType === "") {
      throw optionError(this.bucket, "contentType", "takes a non-empty string", "put");
    }

    return contentType;
  }

  #unsupported(capability: CapabilityName, message: string, operation: string, key: string) {
    return azureBlobError(this.bucket, {
      code: "Unsupported",
      message,
      operation,
      key,
      attempts: 0,
      capability,
    });
  }
}

/**
 * The package is unreleased while its operations arrive one by one, and a call that
 * reaches one still missing says so rather than pretending to a failure of the provider.
 */
function notYetImplemented(what: string): Error {
  return new Error(`${what} is not implemented in adapter-azure-blob yet`);
}

/** Spec 4.2: a string travels as its UTF-8 bytes. */
function bytesOf(body: string | Uint8Array): Uint8Array<ArrayBuffer> {
  return typeof body === "string" ? utf8.encode(body) : heldBytes(body);
}

/**
 * The same bytes as a view `fetch` takes as a body: a view on a `SharedArrayBuffer` is
 * the one body copied rather than sent where it lies.
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
