export const kibibyte: number = 1024;

/** The bytes a body is measured in, where a case names a size spec 9.5 or 9.6 states. */
export const mebibyte: number = 1024 * kibibyte;

/** ADR 0016 makes one part the threshold for a stream, so 17 MiB provokes a multipart upload. */
export const multipartSize: number = 17 * mebibyte;

/**
 * The bytes a case writes: a pattern it rebuilds rather than holds, so that a body the
 * provider reassembled out of order or lost a part of shows up as a mismatch, which one
 * of the same byte repeated would not. Two patterns of different `seed` differ at every
 * byte, so an object holding parts of both matches neither.
 */
export function patternOf(size: number, seed = 0): Uint8Array<ArrayBuffer> {
  const bytes = new Uint8Array(size);

  for (let index = 0; index < size; index += 1) bytes[index] = (index * 7 + seed) % 251;

  return bytes;
}

/** The same bytes as a stream, which is the body spec 4.2 has an adapter send in parts. */
export function streamOf(
  bytes: Uint8Array,
  chunkSize: number,
  onChunk?: (sent: number) => void,
): ReadableStream<Uint8Array> {
  let sent = 0;

  return new ReadableStream({
    pull(controller) {
      if (sent >= bytes.byteLength) {
        controller.close();
        return;
      }

      controller.enqueue(bytes.subarray(sent, Math.min(sent + chunkSize, bytes.byteLength)));
      sent += chunkSize;
      onChunk?.(Math.min(sent, bytes.byteLength));
    },
  });
}

/**
 * The bodies of `put/concurrent-writers` as streams that each hold back their end until
 * every one was read to its last byte. An adapter cannot complete an upload before its
 * stream ends, so before either completes, each writer has read every byte and started
 * every full part, whatever the part size, and the pacing names no adapter. Whether a
 * started part was answered yet is the adapter's timing, which no stream can see.
 */
export function streamsEndingTogether(
  bodies: readonly Uint8Array[],
  chunkSize: number,
): ReadableStream<Uint8Array>[] {
  const { promise: everyEndReached, resolve } = Promise.withResolvers<void>();
  let unended = bodies.length;

  return bodies.map((bytes) => {
    let sent = 0;
    let reachedEnd = false;
    let canceled = false;

    const reachEnd = (): void => {
      if (reachedEnd) return;

      reachedEnd = true;
      unended -= 1;
      if (unended === 0) resolve();
    };

    return new ReadableStream(
      {
        async pull(controller) {
          if (sent < bytes.byteLength) {
            controller.enqueue(bytes.subarray(sent, Math.min(sent + chunkSize, bytes.byteLength)));
            sent += chunkSize;
            return;
          }

          reachEnd();
          await everyEndReached;
          // An adapter may cancel while its read waits here, and a canceled stream
          // refuses `close`.
          if (!canceled) controller.close();
        },
        // Spec 4.2 has a `put` that fails cancel its stream, which is the one sign of a
        // writer that will read no further; the others would otherwise wait for it forever.
        cancel() {
          canceled = true;
          reachEnd();
        },
      },
      // Without a queue, `pull` runs only for a read the adapter asked for, so reaching
      // the end means the adapter took every byte and not that the stream queued ahead.
      { highWaterMark: 0 },
    );
  });
}

export async function collect(stream: ReadableStream<Uint8Array>): Promise<Uint8Array> {
  const chunks: Uint8Array[] = [];
  let size = 0;

  for await (const chunk of stream) {
    chunks.push(chunk);
    size += chunk.byteLength;
  }

  const bytes = new Uint8Array(size);
  let offset = 0;

  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }

  return bytes;
}

/**
 * The stream of `put/abort-during-upload` and of flow 1: it fires the signal once half of
 * the body went out, which is where an upload is interrupted rather than refused.
 */
export function streamAbortedMidway(
  bytes: Uint8Array,
  chunkSize: number,
  controller: AbortController,
): ReadableStream<Uint8Array> {
  return streamOf(bytes, chunkSize, (sent) => {
    if (sent >= bytes.byteLength / 2) controller.abort();
  });
}
