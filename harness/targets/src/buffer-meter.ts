import { memoryUsage } from "node:process";
import { setFlagsFromString } from "node:v8";
import { runInNewContext } from "node:vm";

// Spec 14.4 and spec 14.8: flows 1 and 4 promise that memory does not grow with the size
// of the object, which no call of the core API and no client of a server can observe. What
// the meter measures is the memory held in buffers once everything unreachable is
// collected: without a collection first, the chunks already passed on stay counted until
// the collector happens to run, and the measurement says more about the collector than
// about the code under test. The flag is set here rather than in `vitest.config.ts`, so it
// stays with the files that measure.
setFlagsFromString("--expose-gc");
const exposedCollector: unknown = runInNewContext("gc");

function collectGarbage(): void {
  if (typeof exposedCollector !== "function") throw new Error("V8 exposed no `gc`");

  Reflect.apply(exposedCollector, undefined, []);
}

export const mebibyte: number = 1024 * 1024;

/**
 * Spec 7.6 and spec 8.6: the part buffers an upload of `adapter-s3` or `adapter-azure-blob`
 * holds for an object of any size.
 */
export const defaultPartSize: number = 8 * mebibyte;
export const defaultConcurrency = 4;

export const measurementTimeout = 60_000;

/** How often a run samples, in bytes passed: often enough to see every part in flight. */
const sampleInterval = 8 * mebibyte;

function liveBufferBytes(): number {
  collectGarbage();

  return memoryUsage().arrayBuffers;
}

export interface BufferMeter {
  readonly sample: () => void;
  readonly growth: () => number;
}

/**
 * The largest amount of buffer memory alive at any sample, above what was alive before.
 * `memoryUsage()` counts the whole process, which Vitest's default `forks` pool gives a
 * file to itself; under the `threads` pool the other files' buffers would count as well.
 */
export function bufferMeter(): BufferMeter {
  const baseline = liveBufferBytes();
  let peak = baseline;

  return {
    sample() {
      peak = Math.max(peak, liveBufferBytes());
    },
    growth: () => peak - baseline,
  };
}

/**
 * `size` bytes made one chunk at a time as they are pulled, so the source holds nothing the
 * reader did not ask for. `onSample` runs every `sampleInterval` bytes.
 */
export function generatedStream(size: number, onSample?: () => void): ReadableStream<Uint8Array> {
  let pulled = 0;

  return new ReadableStream({
    pull(controller) {
      if (pulled >= size) {
        controller.close();
        return;
      }

      const length = Math.min(mebibyte, size - pulled);

      controller.enqueue(new Uint8Array(length).fill(pulled / mebibyte));
      pulled += length;

      if (pulled % sampleInterval === 0) onSample?.();
    },
  });
}

/** Reads a stream to its end and keeps none of it, answering how many bytes it read. */
export async function drain(
  stream: ReadableStream<Uint8Array>,
  onSample: () => void,
): Promise<number> {
  let read = 0;

  for await (const chunk of stream) {
    const before = read;

    read += chunk.byteLength;

    if (Math.floor(read / sampleInterval) > Math.floor(before / sampleInterval)) onSample();
  }

  return read;
}
