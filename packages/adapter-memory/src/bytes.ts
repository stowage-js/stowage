import type { PutBody } from "@stowage/core";

export async function readBody(
  body: PutBody,
  signal?: AbortSignal,
): Promise<Uint8Array<ArrayBuffer>> {
  if (typeof body === "string") return new TextEncoder().encode(body);
  if (body instanceof Uint8Array) return new Uint8Array(body);
  return await readStream(body, signal);
}

// The bytes a storage holds sit in a buffer of their own, which is what `digest` takes:
// `BufferSource` rules out a view on a `SharedArrayBuffer`.
export async function sha256Hex(bytes: Uint8Array<ArrayBuffer>): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", bytes);

  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

async function readStream(
  stream: ReadableStream<Uint8Array>,
  signal?: AbortSignal,
): Promise<Uint8Array<ArrayBuffer>> {
  const chunks: Uint8Array[] = [];
  let size = 0;

  // Spec 4.2: leaving the loop early cancels the stream, which is what the caller is
  // promised for an upload that did not read it to its end.
  for await (const chunk of stream) {
    signal?.throwIfAborted();

    chunks.push(chunk);
    size += chunk.byteLength;
  }

  return join(chunks, size);
}

function join(chunks: readonly Uint8Array[], size: number): Uint8Array<ArrayBuffer> {
  const bytes = new Uint8Array(size);
  let offset = 0;

  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }

  return bytes;
}
