import type {
  CapabilityName,
  ContentHeaders,
  CopyOptions,
  DeleteOptions,
  DeleteReport,
  GetOptions,
  ListOptions,
  ObjectEntry,
  ObjectListing,
  ObjectStat,
  OperationOptions,
  Precondition,
  PutBody,
  PutOptions,
  Storage,
  StorageError,
  StoredObject,
} from "@stowage/core";

import { cancelBody, readBody } from "./bytes.ts";
import { readContentHeaders } from "./content-headers.ts";
import { etagOf } from "./etag.ts";
import { keyError, requireKey } from "./key.ts";
import { createListing } from "./listing.ts";
import {
  copyOptionKeys,
  deleteOptionKeys,
  getOptionKeys,
  operationOptionKeys,
  putOptionKeys,
  requireKnownOptions,
} from "./options.ts";
import { preconditionFailure, readPrecondition } from "./precondition.ts";
import { requireRange, sliceRange } from "./range.ts";
import { memoryError } from "./storage-error.ts";
import { createStoredObject } from "./stored-object.ts";
import { readUserMetadata } from "./user-metadata.ts";

export interface MemoryStorage extends Storage {
  readonly provider: "memory";
}

export function memoryStorage(): MemoryStorage {
  return new InMemoryStorage();
}

const defaultContentType = "application/octet-stream";

// One frozen array behind every storage: the declaration is fixed once the storage is
// constructed, and a caller reaching past the `readonly` type reaches all of them.
const memoryCapabilities: readonly CapabilityName[] = Object.freeze([
  "contentHeaders",
  "deleteIfUnchanged",
  "keyBytesPreserved",
  "rangeReads",
  "userMetadata",
  "userMetadataTokenKeys",
  "writeIfAbsent",
  "writeIfUnchanged",
] as const);

interface MemoryObject {
  readonly key: string;
  readonly bytes: Uint8Array<ArrayBuffer>;
  readonly contentType: string;
  readonly contentHeaders: ContentHeaders;
  readonly userMetadata: Readonly<Record<string, string>>;
  readonly etag: string;
  readonly lastModified: Date;
}

class InMemoryStorage implements MemoryStorage {
  readonly provider = "memory" as const;
  readonly bucket: string = "memory";
  readonly capabilities: readonly CapabilityName[] = memoryCapabilities;

  readonly #objects = new Map<string, MemoryObject>();

  async put(key: string, body: PutBody, options?: PutOptions): Promise<ObjectStat> {
    const { precondition, ...described } = await this.#accept(key, body, options);
    const bytes = await readBody(body, options?.signal);
    const object: MemoryObject = {
      key,
      bytes,
      ...described,
      etag: await etagOf(bytes),
      lastModified: new Date(),
    };

    // ADR 0072: nothing awaits between the check and the store, so no other call on the
    // storage runs between them.
    this.#store(object, precondition, "put");

    return describe(object);
  }

  /**
   * What `put` checks in front of the body, answering with the headers and the metadata to
   * hold. Spec 4.2 leaves a stream at its end or canceled once `put` settled, so a refusal
   * here cancels the body it is not going to read.
   */
  async #accept(
    key: string,
    body: PutBody,
    options?: PutOptions,
  ): Promise<
    Pick<MemoryObject, "contentType" | "contentHeaders" | "userMetadata"> & {
      readonly precondition: Precondition | undefined;
    }
  > {
    try {
      requireKey(key, "writable", "put");
      requireKnownOptions(options, putOptionKeys, "put");

      const userMetadata = readUserMetadata(options?.userMetadata, key, this.capabilities);
      const contentType = options?.contentType ?? defaultContentType;

      return {
        contentType,
        userMetadata,
        contentHeaders: readContentHeaders(options ?? {}, contentType, key, this.capabilities),
        precondition: readPrecondition(options?.onlyIf, "write", "put", key, this.capabilities),
      };
    } catch (refusal) {
      await cancelBody(body, refusal);

      throw refusal;
    }
  }

  async get(key: string, options?: GetOptions): Promise<StoredObject> {
    requireKey(key, "addressable", "get");
    requireKnownOptions(options, getOptionKeys, "get");
    requireRange(options?.range);

    options?.signal?.throwIfAborted();

    const object = this.#require(key, "get");

    return createStoredObject(describe(object), sliceRange(object.bytes, options?.range, key));
  }

  async stat(key: string, options?: OperationOptions): Promise<ObjectStat> {
    requireKey(key, "addressable", "stat");
    requireKnownOptions(options, operationOptionKeys, "stat");

    options?.signal?.throwIfAborted();

    return describe(this.#require(key, "stat"));
  }

  async exists(key: string, options?: OperationOptions): Promise<boolean> {
    requireKey(key, "addressable", "exists");
    requireKnownOptions(options, operationOptionKeys, "exists");

    options?.signal?.throwIfAborted();

    return this.#objects.has(key);
  }

  list(options?: ListOptions): ObjectListing {
    return createListing(() => this.#entries(), options);
  }

  delete(...keys: readonly string[]): Promise<DeleteReport>;
  delete(key: string, options: DeleteOptions): Promise<DeleteReport>;
  async delete(...args: readonly string[] | OneKeyWithOptions): Promise<DeleteReport> {
    if (isOneKeyWithOptions(args)) return this.#deleteOne(...args);

    const keys = args;
    const failed: StorageError[] = [];

    for (const key of keys) {
      const error = keyError(key, "addressable", "delete");

      if (error === undefined) this.#objects.delete(key);
      else failed.push(error);
    }

    return { requested: keys.length, failed };
  }

  /**
   * Spec 4.7 reads a failed precondition as the key's entry, as an invalid key is. Nothing
   * awaits between the check and the removal, so no other call runs between them (ADR 0072).
   */
  #deleteOne(key: string, options: DeleteOptions): DeleteReport {
    requireKnownOptions(options, deleteOptionKeys, "delete");

    const precondition = readPrecondition(
      options.onlyIf,
      "delete",
      "delete",
      key,
      this.capabilities,
    );

    options.signal?.throwIfAborted();

    const error =
      keyError(key, "addressable", "delete") ??
      preconditionFailure(precondition, this.#objects.get(key), "delete", key);

    if (error === undefined) this.#objects.delete(key);

    return { requested: 1, failed: error === undefined ? [] : [error] };
  }

  async deleteAll(prefix: string, options?: OperationOptions): Promise<DeleteReport> {
    requireKey(prefix, "prefix", "deleteAll");
    requireKnownOptions(options, operationOptionKeys, "deleteAll");

    options?.signal?.throwIfAborted();

    const keys = [...this.#objects.keys()].filter((key) => key.startsWith(prefix));

    for (const key of keys) this.#objects.delete(key);

    return { requested: keys.length, failed: [] };
  }

  async copy(from: string, to: string, options?: CopyOptions): Promise<ObjectStat> {
    return this.#copy(from, to, "copy", options);
  }

  async move(from: string, to: string, options?: CopyOptions): Promise<ObjectStat> {
    const destination = this.#copy(from, to, "move", options);

    this.#objects.delete(from);

    return destination;
  }

  #copy(from: string, to: string, operation: string, options?: CopyOptions): ObjectStat {
    requireKey(from, "addressable", operation);
    requireKey(to, "writable", operation);
    requireKnownOptions(options, copyOptionKeys, operation);

    const precondition = readPrecondition(
      options?.onlyIf,
      "write",
      operation,
      to,
      this.capabilities,
    );

    options?.signal?.throwIfAborted();

    if (from === to) {
      throw memoryError({
        code: "InvalidRequest",
        message: `The key ${JSON.stringify(from)} is both the source and the destination`,
        operation,
        key: from,
        attempts: 0,
      });
    }

    const source = this.#require(from, operation);
    // Nothing writes to the bytes of a stored object: `put` replaces the whole record and
    // `get` copies on the way out, so the destination shares them with its source.
    const object: MemoryObject = { ...source, key: to, lastModified: new Date() };

    this.#store(object, precondition, operation);

    return describe(object);
  }

  /** Stores the object where the precondition holds at its key, and leaves the key otherwise. */
  #store(object: MemoryObject, precondition: Precondition | undefined, operation: string): void {
    const held = this.#objects.get(object.key);
    const failure = preconditionFailure(precondition, held, operation, object.key);

    if (failure !== undefined) throw failure;

    this.#objects.set(object.key, object);
  }

  // A listing pages through one order, so the snapshot it reads is sorted by key. The
  // order itself is not promised, and no reader may rely on it.
  #entries(): readonly ObjectEntry[] {
    return Array.from(this.#objects.values(), entryOf).toSorted((one, other) =>
      one.key < other.key ? -1 : one.key > other.key ? 1 : 0,
    );
  }

  #require(key: string, operation: string): MemoryObject {
    const object = this.#objects.get(key);

    if (object === undefined) {
      throw memoryError({
        code: "NotFound",
        message: `No object under the key ${JSON.stringify(key)}`,
        operation,
        key,
        attempts: 1,
      });
    }

    return object;
  }
}

type OneKeyWithOptions = readonly [key: string, options: DeleteOptions];

/** The form of `delete` for one key: a second argument that is no key (spec 4.1). */
function isOneKeyWithOptions(
  args: readonly string[] | OneKeyWithOptions,
): args is OneKeyWithOptions {
  return args.length === 2 && typeof args[1] === "object" && args[1] !== null;
}

function describe(object: MemoryObject): ObjectStat {
  return {
    ...entryOf(object),
    contentType: object.contentType,
    ...object.contentHeaders,
    userMetadata: object.userMetadata,
  };
}

// What a listing yields carries neither the content type, the content headers nor the user
// metadata, because a listing response of a provider carries none of them (spec 4.4).
function entryOf(object: MemoryObject): ObjectEntry {
  return {
    key: object.key,
    size: object.bytes.byteLength,
    lastModified: new Date(object.lastModified),
    etag: object.etag,
  };
}
