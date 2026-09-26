import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { memoryUsage } from "node:process";
import { setFlagsFromString } from "node:v8";
import { runInNewContext } from "node:vm";

import { afterEach, expect, test, vi } from "vitest";

import {
  type AzureBlobAdapterOptions,
  azureBlobStorage,
} from "../packages/adapter-azure-blob/src/index.ts";
import { type FsStorage, fsStorage } from "../packages/adapter-fs/src/index.ts";
import { memoryStorage } from "../packages/adapter-memory/src/index.ts";
import { type S3AdapterOptions, s3Storage } from "../packages/adapter-s3/src/index.ts";

// Spec 9.4: flows 1 and 4 promise that memory does not grow with the size of the object,
// which no call of the core API can observe. What these tests measure is the memory held
// in buffers once everything unreachable is collected: without a collection first, the
// chunks already passed on stay counted until the collector happens to run, and the
// measurement says more about the collector than about the adapter. The flag is set here
// rather than in `vitest.config.ts`, so it stays with the one file that measures.
setFlagsFromString("--expose-gc");
const exposedCollector: unknown = runInNewContext("gc");

function collectGarbage(): void {
  if (typeof exposedCollector !== "function") throw new Error("V8 exposed no `gc`");

  Reflect.apply(exposedCollector, undefined, []);
}

const mebibyte = 1024 * 1024;

/** Many times what any adapter may hold, so an object held whole cannot pass unnoticed. */
const objectSize = 256 * mebibyte;

/** What a run holds besides the adapter: the chunk in hand, the stub's answers, V8's own. */
const slack = 16 * mebibyte;

/**
 * Spec 7.6 and spec 8.6: the part buffers an upload of `adapter-s3` or `adapter-azure-blob`
 * holds for an object of any size.
 */
const defaultPartSize = 8 * mebibyte;
const defaultConcurrency = 4;

const measurementTimeout = 60_000;

/** How often a run samples, in bytes passed: often enough to see every part in flight. */
const sampleInterval = 8 * mebibyte;

/**
 * The largest amount of buffer memory alive at any sample, above what was alive before.
 * `memoryUsage()` counts the whole process, which Vitest's default `forks` pool gives this
 * file to itself; under the `threads` pool the other files' buffers would count as well.
 */
function bufferMeter(): { sample: () => void; growth: () => number } {
  const live = (): number => {
    collectGarbage();

    return memoryUsage().arrayBuffers;
  };
  const baseline = live();
  let peak = baseline;

  return {
    sample() {
      peak = Math.max(peak, live());
    },
    growth: () => peak - baseline,
  };
}

/**
 * `size` bytes made one chunk at a time as they are pulled, so the source holds nothing the
 * adapter did not ask for. `onSample` runs every `sampleInterval` bytes.
 */
function generatedStream(size: number, onSample?: () => void): ReadableStream<Uint8Array> {
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
async function drain(stream: ReadableStream<Uint8Array>, onSample: () => void): Promise<number> {
  let read = 0;

  for await (const chunk of stream) {
    const before = read;

    read += chunk.byteLength;

    if (Math.floor(read / sampleInterval) > Math.floor(before / sampleInterval)) onSample();
  }

  return read;
}

const roots: string[] = [];

afterEach(async () => {
  vi.unstubAllGlobals();
  await Promise.all(roots.splice(0).map(async (root) => await rm(root, { recursive: true })));
});

// A meter that cannot fail proves nothing. `adapter-memory` holds the object whole by
// design (flow 1 excepts it), so this is what an adapter that buffers looks like.
test(
  "the meter sees an object held whole",
  async () => {
    const storage = memoryStorage();
    const meter = bufferMeter();

    await storage.put("large.bin", generatedStream(objectSize, meter.sample));
    meter.sample();

    expect(meter.growth()).toBeGreaterThanOrEqual(objectSize);
  },
  measurementTimeout,
);

const s3Options: S3AdapterOptions = {
  bucket: "stowage",
  region: "eu-central-1",
  credentials: { accessKeyId: "AKIDEXAMPLE", secretAccessKey: "secret" },
};

function xml(document: string): Response {
  return new Response(`<?xml version="1.0" encoding="UTF-8"?>\n${document}`, {
    status: 200,
    headers: { "content-type": "application/xml", date: "Sun, 30 Aug 2015 12:36:00 GMT" },
  });
}

/** A provider that accepts every request of a multipart upload and keeps none of its bodies. */
function discardingProvider(onPart: () => void): void {
  vi.stubGlobal("fetch", async (url: string, init: RequestInit): Promise<Response> => {
    const query = new URL(url).searchParams;
    if (init.method === "POST" && query.has("uploads")) {
      return xml(
        "<InitiateMultipartUploadResult><Bucket>stowage</Bucket><Key>large.bin</Key><UploadId>upload-1</UploadId></InitiateMultipartUploadResult>",
      );
    }

    if (init.method === "PUT" && query.has("partNumber")) {
      onPart();

      return new Response(null, {
        status: 200,
        headers: { etag: `"etag-${query.get("partNumber")}"` },
      });
    }

    if (init.method === "POST" && query.has("uploadId")) {
      return xml(
        "<CompleteMultipartUploadResult><Bucket>stowage</Bucket><Key>large.bin</Key><ETag>&quot;assembled&quot;</ETag></CompleteMultipartUploadResult>",
      );
    }

    throw new Error(`The stub answers no ${init.method} ${url}`);
  });
}

test(
  "`adapter-s3` uploads a large stream in flat memory",
  async () => {
    const meter = bufferMeter();

    discardingProvider(meter.sample);

    const written = await s3Storage(s3Options).put(
      "large.bin",
      generatedStream(objectSize, meter.sample),
    );

    expect(written.size).toBe(objectSize);
    expect(meter.growth()).toBeLessThanOrEqual(defaultPartSize * defaultConcurrency + slack);
  },
  measurementTimeout,
);

test(
  "`adapter-s3` streams a large download in flat memory",
  async () => {
    const meter = bufferMeter();

    vi.stubGlobal(
      "fetch",
      async (): Promise<Response> =>
        new Response(generatedStream(objectSize), {
          status: 200,
          headers: {
            "content-length": String(objectSize),
            "last-modified": "Sun, 30 Aug 2015 12:36:00 GMT",
          },
        }),
    );

    const stored = await s3Storage(s3Options).get("large.bin");

    expect(await drain(stored.stream(), meter.sample)).toBe(objectSize);
    expect(meter.growth()).toBeLessThanOrEqual(slack);
  },
  measurementTimeout,
);

const azureBlobOptions: AzureBlobAdapterOptions = {
  account: "stowage",
  container: "stowage",
  // The emulator's published key: any Base64 serves, since the stub checks no signature.
  credentials: {
    accountKey:
      "Eby8vdM02xNOcqFlqUwJPLlmEtlCDXJ1OUzFT50uSRZ6IFsuFq2UVErCz4I6tq/K1SZFPTOtr/KBHBeksoGMGw==",
  },
};

/** What Azure answers `Put Block List` with: the entity tag and the time it wrote the blob. */
function created(): Response {
  return new Response(null, {
    status: 201,
    headers: { etag: '"0x8DCA1B2C3D4E5F6"', "last-modified": "Sun, 30 Aug 2015 12:36:00 GMT" },
  });
}

/** A provider that accepts every request of a block upload and keeps none of its bodies. */
function discardingBlobProvider(onBlock: () => void): void {
  vi.stubGlobal("fetch", async (url: string, init: RequestInit): Promise<Response> => {
    const comp = new URL(url).searchParams.get("comp");

    if (init.method === "PUT" && comp === "block") {
      onBlock();

      return new Response(null, { status: 201 });
    }

    if (init.method === "PUT" && comp === "blocklist") return created();

    throw new Error(`The stub answers no ${init.method} ${url}`);
  });
}

test(
  "`adapter-azure-blob` uploads a large stream in flat memory",
  async () => {
    const meter = bufferMeter();

    discardingBlobProvider(meter.sample);

    const written = await azureBlobStorage(azureBlobOptions).put(
      "large.bin",
      generatedStream(objectSize, meter.sample),
    );

    expect(written.size).toBe(objectSize);
    expect(meter.growth()).toBeLessThanOrEqual(defaultPartSize * defaultConcurrency + slack);
  },
  measurementTimeout,
);

test(
  "`adapter-azure-blob` streams a large download in flat memory",
  async () => {
    const meter = bufferMeter();

    vi.stubGlobal(
      "fetch",
      async (): Promise<Response> =>
        new Response(generatedStream(objectSize), {
          status: 200,
          headers: {
            "content-length": String(objectSize),
            "last-modified": "Sun, 30 Aug 2015 12:36:00 GMT",
          },
        }),
    );

    const stored = await azureBlobStorage(azureBlobOptions).get("large.bin");

    expect(await drain(stored.stream(), meter.sample)).toBe(objectSize);
    expect(meter.growth()).toBeLessThanOrEqual(slack);
  },
  measurementTimeout,
);

async function temporaryFsStorage(): Promise<FsStorage> {
  const root = await mkdtemp(join(tmpdir(), "stowage-flat-memory-"));

  roots.push(root);

  return fsStorage({ root });
}

test(
  "`adapter-fs` uploads a large stream in flat memory",
  async () => {
    const storage = await temporaryFsStorage();
    const meter = bufferMeter();

    const written = await storage.put("large.bin", generatedStream(objectSize, meter.sample));

    expect(written.size).toBe(objectSize);
    expect(meter.growth()).toBeLessThanOrEqual(slack);
  },
  measurementTimeout,
);

test(
  "`adapter-fs` streams a large download in flat memory",
  async () => {
    const storage = await temporaryFsStorage();

    await storage.put("large.bin", generatedStream(objectSize));

    const meter = bufferMeter();
    const stored = await storage.get("large.bin");

    expect(await drain(stored.stream(), meter.sample)).toBe(objectSize);
    expect(meter.growth()).toBeLessThanOrEqual(slack);
  },
  measurementTimeout,
);
