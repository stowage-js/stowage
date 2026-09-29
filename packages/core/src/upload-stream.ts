import { StorageError } from "./errors.ts";
import { type Part, PartReader } from "./part-reader.ts";

export interface StreamUploadOptions {
  readonly partSize: number;
  readonly concurrency: number;
  /** The provider's limit on the parts of one upload, `Infinity` where it has none. */
  readonly maxParts: number;
  /** What the `InvalidRequest` for a stream above `maxParts` is told against. */
  readonly bucket: string;
  readonly provider: string;
  readonly key: string;
  readonly signal?: AbortSignal;
}

export interface StreamUpload<T> {
  /** The stream ended within the first part: the bytes go as one request. */
  whole(bytes: Uint8Array<ArrayBuffer>): Promise<T>;
  /** The first part filled: the adapter starts, sends through `sendParts`, and commits. */
  multipart(sendParts: SendParts): Promise<T>;
}

export type SendParts = <R>(
  send: (index: number, bytes: Uint8Array<ArrayBuffer>, signal: AbortSignal) => Promise<R>,
) => Promise<{ readonly results: readonly R[]; readonly size: number }>;

/**
 * Reads the stream into parts of `partSize` and hands a stream that ends within the first
 * to `whole`, any other to `multipart`. The reader, its buffers and the cancellation of
 * the source stay here, so the spec promises one call rather than the order of five
 * (ADR 0030).
 *
 * The source is canceled wherever the upload settles before the stream ended, as spec 4.2
 * has it for a `put` that rejects before reading its body to the end.
 */
export async function uploadStream<T>(
  stream: ReadableStream<Uint8Array>,
  options: StreamUploadOptions,
  upload: StreamUpload<T>,
): Promise<T> {
  const parts = new PartReader(stream, options.partSize, options.signal);
  // Aborted once the upload settled, so a `sendParts` that `multipart` did not wait for,
  // or kept to call later, stops rather than sending the part the canceled stream cut short.
  const uploadSettled = new AbortController();
  let readToEnd = false;
  let cancelReason: unknown = new Error("The upload settled before the stream ended");

  try {
    const first = await parts.next();

    if (first.last) {
      readToEnd = true;

      return await upload.whole(first.bytes);
    }

    let called = false;
    const sendParts: SendParts = async (send) => {
      uploadSettled.signal.throwIfAborted();

      if (called) throw new Error("`sendParts` sends the parts of one upload once");

      called = true;

      const sent = await sendAll(parts, first, options, uploadSettled.signal, send);

      readToEnd = true;

      return sent;
    };

    return await upload.multipart(sendParts);
  } catch (failure) {
    cancelReason = failure;

    throw failure;
  } finally {
    uploadSettled.abort(cancelReason);
    if (!readToEnd) await parts.cancel(cancelReason);
    parts.release();
  }
}

/**
 * `concurrency` parts in flight, and the next part read only once one of them settled,
 * so the part buffers never outnumber the parts in flight (ADR 0016). The first failure
 * stops the parts still in flight, and is what `sendParts` rejects with once they settled.
 */
async function sendAll<R>(
  parts: PartReader,
  first: Part,
  options: StreamUploadOptions,
  uploadSettled: AbortSignal,
  send: (index: number, bytes: Uint8Array<ArrayBuffer>, signal: AbortSignal) => Promise<R>,
): Promise<{ readonly results: readonly R[]; readonly size: number }> {
  const stop = new AbortController();
  const partSignal =
    options.signal === undefined ? stop.signal : AbortSignal.any([options.signal, stop.signal]);
  const inFlight = new Set<Promise<void>>();
  const results: R[] = [];
  let failure: { readonly reason: unknown } | undefined;
  let size = 0;

  // The source is canceled along with the parts, because a stream that stalls would
  // otherwise hold the upload at the read of a part that is never sent.
  const fail = (reason: unknown): void => {
    failure ??= { reason };
    // Without a reason of its own, so a part still in flight is stopped with the runtime's
    // `AbortError`, which the adapters' requests tell apart from a failure to repeat.
    stop.abort();
    void parts.cancel(reason);
  };
  const sendPart = async (index: number, part: Part): Promise<void> => {
    try {
      results[index] = await send(index, part.bytes, partSignal);
    } catch (reason) {
      fail(reason);
    } finally {
      parts.recycle(part);
    }
  };

  const stopWithUpload = (): void => {
    fail(uploadSettled.reason);
  };

  uploadSettled.addEventListener("abort", stopWithUpload, { once: true });

  try {
    for (let index = 0, part = first; !stop.signal.aborted; index += 1) {
      if (index === options.maxParts - 1 && !part.last) throw tooManyParts(options);

      const sending = sendPart(index, part);

      inFlight.add(sending);
      void sending.finally(() => inFlight.delete(sending));
      size += part.bytes.byteLength;

      if (part.last) break;

      // oxlint-disable-next-line no-await-in-loop -- a free slot is what lets the next part go
      while (inFlight.size >= options.concurrency) await Promise.race(inFlight);

      // oxlint-disable-next-line no-await-in-loop -- the next part is read into the free slot
      part = await parts.next();
    }
  } catch (reason) {
    fail(reason);
  }

  await Promise.all(inFlight);
  uploadSettled.removeEventListener("abort", stopWithUpload);

  if (failure !== undefined) {
    // `fail` only started the cancel. It has finished before the adapter hears of the
    // failure, since spec 7.6 has the source canceled before the upload is aborted.
    await parts.cancel(failure.reason);

    throw failure.reason;
  }

  return { results, size };
}

/**
 * Known once the last part the provider takes is full and the stream goes on. ADR 0016
 * fixes the part size before the first part, so the way past it is a larger one.
 */
function tooManyParts(options: StreamUploadOptions): StorageError {
  return new StorageError({
    code: "InvalidRequest",
    message: `The stream needs more than ${options.maxParts} parts of the configured \`partSize\` of ${options.partSize} bytes; a larger \`multipart.partSize\` carries it`,
    operation: "put",
    bucket: options.bucket,
    provider: options.provider,
    key: options.key,
    attempts: 0,
  });
}
