import type { ObjectStat, StorageError, StoredObject } from "@stowage/core";

import { s3Error } from "./storage-error.ts";

/**
 * Spec 4.5: the description and the body come out of one response, the body is read
 * once, and a stream that breaks after `get` resolved errors with a `StorageError`
 * whichever of the four readers took it.
 */
export function createStoredObject(
  bucket: string,
  stat: ObjectStat,
  response: Response,
): StoredObject {
  let read = false;

  const take = (): void => {
    if (read) {
      throw s3Error(bucket, {
        code: "InvalidRequest",
        message: "The body of this stored object has already been read",
        operation: "get",
        key: stat.key,
        attempts: 0,
      });
    }

    read = true;
  };

  const broken = (failure: unknown): StorageError =>
    s3Error(bucket, {
      code: "NetworkError",
      message: `The body of the object broke while it was read: ${String(failure)}`,
      operation: "get",
      key: stat.key,
      attempts: 1,
      retryable: true,
      cause: failure,
    });

  const asText = async (): Promise<string> => {
    take();

    try {
      return await response.text();
    } catch (failure) {
      throw broken(failure);
    }
  };

  return {
    stat,

    stream(): ReadableStream<Uint8Array> {
      let body: ReadableStream<Uint8Array>;

      try {
        take();
        // A response the provider answered `200` to carries a body, empty object
        // included; the fallback is what a body-less answer would leave behind.
        body = response.body ?? emptyStream();
      } catch (refusal) {
        return new ReadableStream({
          start(controller) {
            controller.error(refusal);
          },
        });
      }

      return reportingFailure(body, broken);
    },

    async bytes(): Promise<Uint8Array> {
      take();

      try {
        return new Uint8Array(await response.arrayBuffer());
      } catch (failure) {
        throw broken(failure);
      }
    },

    text: asText,

    async json<T = unknown>(): Promise<T> {
      return JSON.parse(await asText());
    },
  };
}

function emptyStream(): ReadableStream<Uint8Array> {
  return new ReadableStream({
    start(controller) {
      controller.close();
    },
  });
}

/**
 * The same bytes, with a break of the response body reported as a `StorageError`. A
 * cancel reaches the response through the reader, which is what cancels the request
 * behind the stream (spec 4.5).
 */
function reportingFailure(
  body: ReadableStream<Uint8Array>,
  asStorageError: (failure: unknown) => StorageError,
): ReadableStream<Uint8Array> {
  const reader = body.getReader();

  return new ReadableStream({
    async pull(controller) {
      try {
        const { done, value } = await reader.read();

        if (done) controller.close();
        else controller.enqueue(value);
      } catch (failure) {
        controller.error(asStorageError(failure));
      }
    },

    async cancel(reason: unknown) {
      await reader.cancel(reason);
    },
  });
}
