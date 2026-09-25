import type {
  CapabilityName,
  DeleteReport,
  GetOptions,
  ObjectListing,
  ObjectStat,
  PutBody,
  PutOptions,
  Storage,
  StoredObject,
} from "@stowage/core";

import {
  type AzureBlobAdapterOptions,
  type AzureBlobConfiguration,
  readConfiguration,
} from "./configuration.ts";
import { defaultContentType, describeResponse, describeWrite } from "./description.ts";
import { requireKey } from "./key.ts";
import { getOptionKeys, optionError, putOptionKeys, requireKnownOptions } from "./options.ts";
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

const azureBlobCapabilities: readonly CapabilityName[] = Object.freeze([]);

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

    if (options?.range !== undefined) {
      throw this.#unsupported("rangeReads", "This storage reads no range", "get", key);
    }

    options?.signal?.throwIfAborted();

    const response = await send(this.#configuration, {
      method: "GET",
      operation: "get",
      key,
      signal: options?.signal,
    });

    return createStoredObject(
      this.bucket,
      describeResponse(this.bucket, key, "get", response),
      response,
    );
  }

  async stat(): Promise<ObjectStat> {
    throw notYetImplemented("`stat`");
  }

  async exists(): Promise<boolean> {
    throw notYetImplemented("`exists`");
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
