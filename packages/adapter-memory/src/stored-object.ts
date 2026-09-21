import type { ObjectStat, StoredObject } from "@stowage/core";

import { memoryError } from "./storage-error.ts";

export function createStoredObject(stat: ObjectStat, bytes: Uint8Array<ArrayBuffer>): StoredObject {
  let read = false;

  const take = (): Uint8Array<ArrayBuffer> => {
    if (read) {
      throw memoryError({
        code: "InvalidRequest",
        message: "The body of this stored object has already been read",
        operation: "get",
        key: stat.key,
        attempts: 0,
      });
    }

    read = true;
    return bytes;
  };

  const decoder = new TextDecoder();

  return {
    stat,

    stream(): ReadableStream<Uint8Array> {
      let taken: Uint8Array<ArrayBuffer>;

      try {
        taken = take();
      } catch (error) {
        return new ReadableStream({
          start(controller) {
            controller.error(error);
          },
        });
      }

      return new ReadableStream({
        start(controller) {
          controller.enqueue(new Uint8Array(taken));
          controller.close();
        },
      });
    },

    async bytes(): Promise<Uint8Array> {
      return new Uint8Array(take());
    },

    async text(): Promise<string> {
      return decoder.decode(take());
    },

    // The caller names the type it expects, as `JSON.parse` lets it.
    async json<T = unknown>(): Promise<T> {
      return JSON.parse(decoder.decode(take()));
    },
  };
}
