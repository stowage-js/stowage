/**
 * The bytes a case writes: a pattern it rebuilds rather than holds, so that a body the
 * provider reassembled out of order or lost a part of shows up as a mismatch, which one
 * of the same byte repeated would not.
 */
export function patternOf(size: number): Uint8Array<ArrayBuffer> {
  const bytes = new Uint8Array(size);

  for (let index = 0; index < size; index += 1) bytes[index] = (index * 7) % 251;

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

/** What a stream yielded, joined, which is how a case reads a body `stream()` handed it. */
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
