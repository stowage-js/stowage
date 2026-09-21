import type {
  ObjectStat,
  OperationOptions,
  PutBody,
  PutOptions,
  Storage,
  StoredObject,
} from "@stowage/core";

import { readBody } from "./bytes.ts";
import { etagOf } from "./etag.ts";
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
    options?.signal?.throwIfAborted();

    const object = this.#require(key, "get");

    return createStoredObject(describe(object), object.bytes);
  }

  async stat(key: string, options?: OperationOptions): Promise<ObjectStat> {
    options?.signal?.throwIfAborted();

    return describe(this.#require(key, "stat"));
  }

  async exists(key: string, options?: OperationOptions): Promise<boolean> {
    options?.signal?.throwIfAborted();

    return this.#objects.has(key);
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
