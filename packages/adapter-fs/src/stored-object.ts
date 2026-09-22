import { type FileHandle, open } from "node:fs/promises";

import type { ObjectStat, StoredObject } from "@stowage/core";

import { asFailure } from "./errno.ts";
import type { FsAccessContext } from "./paths.ts";
import { fsError } from "./storage-error.ts";

/** The bytes of one object, as the file they are read from, both ends inclusive. */
export interface FileBody {
  readonly path: string;
  readonly start: number;
  readonly end: number;
}

const chunkSize = 64 * 1024;

/**
 * The object `get` hands back. The file is opened where a reader is taken rather than
 * where the object was described, so a caller reading the description alone holds no
 * open file — the rename `put` lands through is what keeps that reader off a half-written
 * object (spec 6).
 */
export function createStoredObject(
  context: FsAccessContext,
  stat: ObjectStat,
  body: FileBody,
): StoredObject {
  let read = false;

  const take = (): FileBody => {
    if (read) {
      throw fsError(context.root, {
        code: "InvalidRequest",
        message: "The body of this stored object has already been read",
        operation: context.operation,
        key: context.key,
        attempts: 0,
      });
    }

    read = true;
    return body;
  };

  // Spec 4.5 has a body that breaks after `get` resolved arrive as a `StorageError`,
  // whichever of the four readers was taken.
  const fail = (thrown: unknown): unknown => asFailure(thrown, { ...context, access: "read" });

  const decoder = new TextDecoder();

  return {
    stat,

    stream(): ReadableStream<Uint8Array> {
      let taken: FileBody;

      try {
        taken = take();
      } catch (error) {
        return new ReadableStream({
          start(controller) {
            controller.error(error);
          },
        });
      }

      return readStream(taken, fail);
    },

    async bytes(): Promise<Uint8Array> {
      return await readAll(take(), fail);
    },

    async text(): Promise<string> {
      return decoder.decode(await readAll(take(), fail));
    },

    async json<T = unknown>(): Promise<T> {
      return JSON.parse(decoder.decode(await readAll(take(), fail)));
    },
  };
}

type Fail = (thrown: unknown) => unknown;

function readStream(body: FileBody, fail: Fail): ReadableStream<Uint8Array> {
  let handle: FileHandle | undefined;
  let position = body.start;

  return new ReadableStream({
    async pull(controller) {
      const left = body.end - position + 1;

      if (left <= 0) {
        await close(handle);
        controller.close();
        return;
      }

      const buffer = new Uint8Array(Math.min(left, chunkSize));

      try {
        handle ??= await openFile(body.path, fail);

        const { bytesRead } = await handle.read(buffer, 0, buffer.byteLength, position);

        // A file the writer shortened under the reader ends the body where it now ends,
        // rather than leaving the stream waiting for bytes no read answers with.
        if (bytesRead === 0) {
          await close(handle);
          controller.close();
          return;
        }

        position += bytesRead;
        controller.enqueue(buffer.subarray(0, bytesRead));
      } catch (thrown) {
        await close(handle);

        throw fail(thrown);
      }
    },

    async cancel() {
      // Spec 4.5: canceling the stream cancels the read behind it, which here is the
      // file the body was being read from.
      await close(handle);
    },
  });
}

async function readAll(body: FileBody, fail: Fail): Promise<Uint8Array> {
  const size = Math.max(body.end - body.start + 1, 0);
  const bytes = new Uint8Array(size);
  const handle = await openFile(body.path, fail);
  let read = 0;

  try {
    while (read < size) {
      // oxlint-disable-next-line no-await-in-loop -- one file, read in order
      const { bytesRead } = await handle.read(bytes, read, size - read, body.start + read);

      if (bytesRead === 0) break;

      read += bytesRead;
    }
  } catch (thrown) {
    throw fail(thrown);
  } finally {
    await close(handle);
  }

  return read === size ? bytes : bytes.subarray(0, read);
}

async function openFile(path: string, fail: Fail): Promise<FileHandle> {
  try {
    return await open(path, "r");
  } catch (thrown) {
    throw fail(thrown);
  }
}

// The handle is closed once, wherever the body ended, and a close that fails says
// nothing the caller of a read can act on.
async function close(handle: FileHandle | undefined): Promise<void> {
  await handle?.close().catch(() => {});
}
