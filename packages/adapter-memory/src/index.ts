import type {
  DeleteReport,
  ObjectStat,
  OperationOptions,
  PutBody,
  PutOptions,
  Storage,
  StorageError,
  StoredObject,
} from "@stowage/core";

import { readBody } from "./bytes.ts";
import { etagOf } from "./etag.ts";
import { keyError, requireKey } from "./key.ts";
import { memoryError } from "./storage-error.ts";
import { createStoredObject } from "./stored-object.ts";

export interface MemoryStorage extends Storage {
  readonly provider: "memory";
}

export function memoryStorage(): MemoryStorage {
  return new InMemoryStorage();
}

const defaultContentType = "application/octet-stream";

interface MemoryObject {
  readonly key: string;
  readonly bytes: Uint8Array<ArrayBuffer>;
  readonly contentType: string;
  readonly etag: string;
  readonly lastModified: Date;
}

class InMemoryStorage implements MemoryStorage {
  readonly provider = "memory" as const;
  readonly bucket: string = "memory";

  readonly #objects = new Map<string, MemoryObject>();

  async put(key: string, body: PutBody, options?: PutOptions): Promise<ObjectStat> {
    requireKey(key, "writable", "put");

    const bytes = await readBody(body, options?.signal);
    const object: MemoryObject = {
      key,
      bytes,
      contentType: options?.contentType ?? defaultContentType,
      etag: await etagOf(bytes),
      lastModified: new Date(),
    };

    this.#objects.set(key, object);

    return describe(object);
  }

  async get(key: string, options?: OperationOptions): Promise<StoredObject> {
    requireKey(key, "addressable", "get");

    options?.signal?.throwIfAborted();

    const object = this.#require(key, "get");

    return createStoredObject(describe(object), object.bytes);
  }

  async stat(key: string, options?: OperationOptions): Promise<ObjectStat> {
    requireKey(key, "addressable", "stat");

    options?.signal?.throwIfAborted();

    return describe(this.#require(key, "stat"));
  }

  async exists(key: string, options?: OperationOptions): Promise<boolean> {
    requireKey(key, "addressable", "exists");

    options?.signal?.throwIfAborted();

    return this.#objects.has(key);
  }

  async delete(...keys: readonly string[]): Promise<DeleteReport> {
    const failed: StorageError[] = [];

    for (const key of keys) {
      const error = keyError(key, "addressable", "delete");

      if (error === undefined) this.#objects.delete(key);
      else failed.push(error);
    }

    return { requested: keys.length, failed };
  }

  async deleteAll(prefix: string, options?: OperationOptions): Promise<DeleteReport> {
    requireKey(prefix, "prefix", "deleteAll");

    options?.signal?.throwIfAborted();

    const keys = [...this.#objects.keys()].filter((key) => key.startsWith(prefix));

    for (const key of keys) this.#objects.delete(key);

    return { requested: keys.length, failed: [] };
  }

  async copy(from: string, to: string, options?: OperationOptions): Promise<ObjectStat> {
    return this.#copy(from, to, "copy", options);
  }

  async move(from: string, to: string, options?: OperationOptions): Promise<ObjectStat> {
    const destination = this.#copy(from, to, "move", options);

    this.#objects.delete(from);

    return destination;
  }

  #copy(from: string, to: string, operation: string, options?: OperationOptions): ObjectStat {
    requireKey(from, "addressable", operation);
    requireKey(to, "writable", operation);

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

    this.#objects.set(to, object);

    return describe(object);
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

function describe(object: MemoryObject): ObjectStat {
  return {
    key: object.key,
    size: object.bytes.byteLength,
    lastModified: new Date(object.lastModified),
    etag: object.etag,
    contentType: object.contentType,
    userMetadata: {},
  };
}
