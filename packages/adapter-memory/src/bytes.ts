import type { PutBody } from "@stowage/core";

export async function readBody(
  body: PutBody,
  signal?: AbortSignal,
): Promise<Uint8Array<ArrayBuffer>> {
  // A stream carries the signal into the read itself, because spec 4.2 leaves it
  // canceled where `put` rejects rather than at a signal `put` checked in front of it.
  if (isStream(body)) return await readStream(body, signal);

  signal?.throwIfAborted();

  return typeof body === "string" ? new TextEncoder().encode(body) : new Uint8Array(body);
}

/** Spec 4.2 leaves a stream at its end or canceled once `put` settled, read or not. */
export async function cancelBody(body: PutBody, reason: unknown): Promise<void> {
  if (isStream(body)) await body.cancel(reason);
}

function isStream(body: PutBody): body is ReadableStream<Uint8Array> {
  return typeof body !== "string" && !(body instanceof Uint8Array);
}

async function readStream(
  stream: ReadableStream<Uint8Array>,
  signal?: AbortSignal,
): Promise<Uint8Array<ArrayBuffer>> {
  const chunks: Uint8Array[] = [];

  // `pipeTo` keeps both halves of the promise around the signal: it cancels the stream
  // and rejects with the signal's reason, for a signal that fired before the first chunk
  // as well as for one that fires between two of them.
  await stream.pipeTo(
    new WritableStream({
      write(chunk) {
        chunks.push(chunk.slice());
      },
    }),
    { signal },
  );

  return join(chunks);
}

function join(chunks: readonly Uint8Array[]): Uint8Array<ArrayBuffer> {
  const bytes = new Uint8Array(chunks.reduce((size, chunk) => size + chunk.byteLength, 0));
  let offset = 0;

  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }

  return bytes;
}
