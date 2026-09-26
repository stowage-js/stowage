/** Where a buffer starts before the stream has shown whether it fills a part. */
const initialCapacity = 64 * 1024;

export interface Part {
  /** Held whole, because Azure refuses a chunked `Put Blob` and a repeat sends it again (spec 8.4). */
  readonly bytes: Uint8Array<ArrayBuffer>;
  /** Whether the stream ended with this part, which decides between one `Put Blob` and blocks. */
  readonly last: boolean;
}

/**
 * A stream read into parts of one size (spec 8.6). A part is known to be the last only
 * once the stream has ended behind it, so a full part looks one chunk ahead; that chunk
 * is the stream's own and becomes the start of the next part.
 *
 * A part handed back through `recycle` lends its buffer to a later one. ADR 0016 bounds
 * an upload at `partSize × concurrency` of buffers, and a fresh buffer per part would
 * keep the settled ones alive until the collector noticed them.
 *
 * Until a part has filled, the buffer grows by doubling, because ADR 0009 has a body
 * shorter than a part allocate only what it needs. Once one has, the stream is known to
 * go as blocks, and every buffer after it starts at the full part size.
 */
export class PartReader {
  readonly #reader: ReadableStreamDefaultReader<Uint8Array>;
  readonly #partSize: number;
  readonly #signal: AbortSignal | undefined;
  readonly #cancelOnAbort = (): void => {
    void this.#reader.cancel(this.#signal?.reason).catch(() => {});
  };
  readonly #free: ArrayBuffer[] = [];
  #ahead: Uint8Array | undefined;
  #filledOnce = false;

  constructor(stream: ReadableStream<Uint8Array>, partSize: number, signal?: AbortSignal) {
    this.#reader = stream.getReader();
    this.#partSize = partSize;
    this.#signal = signal;

    // A source that stalls would otherwise hold `put` past the caller's abort: canceling
    // the reader settles the read it is waiting on.
    signal?.addEventListener("abort", this.#cancelOnAbort, { once: true });
  }

  async next(): Promise<Part> {
    let bytes = this.#freshBuffer();
    let filled = 0;

    while (filled < this.#partSize) {
      // oxlint-disable-next-line no-await-in-loop -- one part is filled chunk by chunk
      const chunk = this.#ahead ?? (await this.#read());

      this.#ahead = undefined;

      if (chunk === undefined) return { bytes: bytes.subarray(0, filled), last: true };

      const taken = Math.min(chunk.byteLength, this.#partSize - filled);

      if (filled + taken > bytes.byteLength) bytes = this.#grown(bytes, filled + taken);

      bytes.set(chunk.subarray(0, taken), filled);
      filled += taken;

      if (taken < chunk.byteLength) this.#ahead = chunk.subarray(taken);
    }

    this.#filledOnce = true;
    this.#ahead ??= await this.#read();

    return { bytes, last: this.#ahead === undefined };
  }

  /** The part's request settled, so nothing reads its bytes any more. */
  recycle(part: Part): void {
    // A buffer that never grew to the part size is a last part's, and no part follows it.
    if (part.bytes.buffer.byteLength === this.#partSize) this.#free.push(part.bytes.buffer);
  }

  /** Spec 4.2 leaves the stream canceled where `put` rejects before reading it to its end. */
  async cancel(reason: unknown): Promise<void> {
    await this.#reader.cancel(reason).catch(() => {});
  }

  release(): void {
    this.#signal?.removeEventListener("abort", this.#cancelOnAbort);
    this.#reader.releaseLock();
  }

  #freshBuffer(): Uint8Array<ArrayBuffer> {
    const pooled = this.#free.pop();

    if (pooled !== undefined) return new Uint8Array(pooled);

    return new Uint8Array(
      this.#filledOnce ? this.#partSize : Math.min(this.#partSize, initialCapacity),
    );
  }

  #grown(bytes: Uint8Array<ArrayBuffer>, needed: number): Uint8Array<ArrayBuffer> {
    let capacity = bytes.byteLength;

    while (capacity < needed) capacity *= 2;

    const larger = new Uint8Array(Math.min(capacity, this.#partSize));

    larger.set(bytes);

    return larger;
  }

  async #read(): Promise<Uint8Array | undefined> {
    for (;;) {
      // oxlint-disable-next-line no-await-in-loop -- an empty chunk says nothing of the end
      const { done, value } = await this.#reader.read();

      this.#signal?.throwIfAborted();

      if (done) return undefined;
      if (value.byteLength > 0) return value;
    }
  }
}
