export interface Part {
  /** Held whole, because signing hashes it and a repeat sends it again (ADR 0009). */
  readonly bytes: Uint8Array<ArrayBuffer>;
  /** Whether the stream ended with this part, which decides between one `PUT` and many. */
  readonly last: boolean;
}

/**
 * A stream read into parts of one size (spec 7.6). A part is known to be the last only
 * once the stream has ended behind it, so a full part looks one chunk ahead; that chunk
 * is the stream's own and becomes the start of the next part.
 */
export class PartReader {
  readonly #reader: ReadableStreamDefaultReader<Uint8Array>;
  readonly #partSize: number;
  readonly #signal: AbortSignal | undefined;
  readonly #cancelOnAbort = (): void => {
    void this.#reader.cancel(this.#signal?.reason).catch(() => {});
  };
  #ahead: Uint8Array | undefined;

  constructor(stream: ReadableStream<Uint8Array>, partSize: number, signal?: AbortSignal) {
    this.#reader = stream.getReader();
    this.#partSize = partSize;
    this.#signal = signal;

    // A source that stalls would otherwise hold `put` past the caller's abort: canceling
    // the reader settles the read it is waiting on.
    signal?.addEventListener("abort", this.#cancelOnAbort, { once: true });
  }

  async next(): Promise<Part> {
    const bytes = new Uint8Array(this.#partSize);
    let filled = 0;

    while (filled < this.#partSize) {
      // oxlint-disable-next-line no-await-in-loop -- one part is filled chunk by chunk
      const chunk = this.#ahead ?? (await this.#read());

      this.#ahead = undefined;

      if (chunk === undefined) return { bytes: bytes.subarray(0, filled), last: true };

      const taken = Math.min(chunk.byteLength, this.#partSize - filled);

      bytes.set(chunk.subarray(0, taken), filled);
      filled += taken;

      if (taken < chunk.byteLength) this.#ahead = chunk.subarray(taken);
    }

    this.#ahead ??= await this.#read();

    return { bytes, last: this.#ahead === undefined };
  }

  /** Spec 4.2 leaves the stream canceled where `put` rejects before reading it to its end. */
  async cancel(reason: unknown): Promise<void> {
    await this.#reader.cancel(reason).catch(() => {});
  }

  release(): void {
    this.#signal?.removeEventListener("abort", this.#cancelOnAbort);
    this.#reader.releaseLock();
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
