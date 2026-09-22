import type { FileHandle } from "node:fs/promises";

import type { PutBody } from "@stowage/core";

const utf8 = new TextEncoder();

/**
 * Writes the body into the open file. A stream goes chunk by chunk, so that an upload of
 * any size costs one chunk of memory rather than the object.
 */
export async function writeBody(
  handle: FileHandle,
  body: PutBody,
  signal?: AbortSignal,
): Promise<void> {
  if (isStream(body)) {
    // `pipeTo` keeps both halves of the promise around the signal: it cancels the stream
    // and rejects with the signal's reason, for a signal that fired before the first
    // chunk as well as for one that fires between two of them.
    await body.pipeTo(
      new WritableStream<Uint8Array>({
        async write(chunk) {
          await writeAll(handle, chunk);
        },
      }),
      { signal },
    );

    return;
  }

  signal?.throwIfAborted();

  await writeAll(handle, typeof body === "string" ? utf8.encode(body) : body);
}

/** Spec 4.2 leaves a stream at its end or canceled once `put` settled, read or not. */
export async function cancelBody(body: PutBody, reason: unknown): Promise<void> {
  // A stream still locked is one `pipeTo` holds and has already canceled, and canceling
  // one that broke rejects with what broke it rather than with the refusal at hand.
  if (!isStream(body) || body.locked) return;

  await body.cancel(reason).catch(() => {});
}

function isStream(body: PutBody): body is ReadableStream<Uint8Array> {
  return typeof body !== "string" && !(body instanceof Uint8Array);
}

async function writeAll(handle: FileHandle, bytes: Uint8Array): Promise<void> {
  for (let written = 0; written < bytes.byteLength;) {
    // oxlint-disable-next-line no-await-in-loop -- one file, written in order
    const { bytesWritten } = await handle.write(bytes, written, bytes.byteLength - written);

    written += bytesWritten;
  }
}
