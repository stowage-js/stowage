import type {
  ObjectStat,
  OperationOptions,
  PutBody,
  PutOptions,
  Storage,
  StoredObject,
} from "@stowage/core";

import { readBody, sha256Hex } from "./bytes.ts";
import { memoryError, memoryName } from "./storage-error.ts";
import { createStoredObject } from "./stored-object.ts";

export interface MemoryStorage extends Storage {
  readonly provider: "memory";
}

export function memoryStorage(): MemoryStorage {
  return new InMemoryStorage();
}

const defaultContentType = "application/octet-stream";

interface StoredEntry {
  readonly bytes: Uint8Array<ArrayBuffer>;
  readonly contentType: string;
  readonly etag: string;
  readonly lastModified: Date;
}

class InMemoryStorage implements MemoryStorage {
  readonly provider: "memory" = memoryName;
  readonly bucket: string = memoryName;

  readonly #objects = new Map<string, StoredEntry>();

  async put(key: string, body: PutBody, options?: PutOptions): Promise<ObjectStat> {
    options?.signal?.throwIfAborted();

    const bytes = await readBody(body, options?.signal);
    const entry: StoredEntry = {
      bytes,
      contentType: options?.contentType ?? defaultContentType,
      etag: await sha256Hex(bytes),
      lastModified: new Date(),
    };

    this.#objects.set(key, entry);

    return describe(key, entry);
  }

  async get(key: string, options?: OperationOptions): Promise<StoredObject> {
    options?.signal?.throwIfAborted();

    const entry = this.#require(key, "get");

    return createStoredObject(describe(key, entry), entry.bytes);
  }

  async stat(key: string, options?: OperationOptions): Promise<ObjectStat> {
    options?.signal?.throwIfAborted();

    return describe(key, this.#require(key, "stat"));
  }

  async exists(key: string, options?: OperationOptions): Promise<boolean> {
    options?.signal?.throwIfAborted();

    return this.#objects.has(key);
  }

  #require(key: string, operation: string): StoredEntry {
    const entry = this.#objects.get(key);

    if (entry === undefined) {
      throw memoryError({
        code: "NotFound",
        message: `No object under the key ${JSON.stringify(key)}`,
        operation,
        key,
        attempts: 1,
      });
    }

    return entry;
  }
}

function describe(key: string, entry: StoredEntry): ObjectStat {
  return {
    key,
    size: entry.bytes.byteLength,
    lastModified: new Date(entry.lastModified),
    etag: entry.etag,
    contentType: entry.contentType,
  };
}
