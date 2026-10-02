import { once } from "node:events";
import { type IncomingMessage, request } from "node:http";

import { type S3AdapterOptions, s3Storage } from "../../../packages/adapter-s3/src/index.ts";
import { assert } from "../../../packages/conformance/src/assertions.ts";
import {
  bufferMeter,
  defaultConcurrency,
  defaultPartSize,
  drain,
  generatedStream,
  mebibyte,
} from "./buffer-meter.ts";
import type { HttpServer } from "./http.ts";

/** Many times either bound below, so an object held whole cannot pass unnoticed. */
const objectSize = 1024 * mebibyte;

/**
 * Over a socket each part in flight is held more than once: the part buffer, the copy
 * `fetch` takes of a body handed over as bytes (the Fetch standard's "extract a body") and
 * the copy `crypto.subtle.digest` takes to hash it for the signature. The client shares the
 * process and counts too. Measured on Node 24 at 77 to 138 MiB from 128 MiB to 1 GiB alike,
 * the most against SeaweedFS, which takes parts slower than a stub; six times the part
 * buffers leave room above that and stay far below the object.
 */
const uploadBound = 6 * defaultPartSize * defaultConcurrency;

/**
 * What is in flight between the provider, the server and the client, which no reader holds
 * on to. Measured on Node 24 at 24 to 38 MiB for 256 MiB to 2 GiB alike.
 */
const downloadBound = 64 * mebibyte;

/**
 * Twice the adapters' measurement: the download seeds its 1 GiB through the same test, and
 * a CI runner's SeaweedFS takes it slower than a laptop's.
 */
const measurementTimeout = 120_000;

/** `describe` and `test` of Vitest, whose default timeout no measurement fits into. */
export interface MeasuringFramework {
  describe(name: string, body: () => void): void;
  test(name: string, body: () => Promise<void>, timeout: number): void;
}

/**
 * Spec 14.8's second promise that no client observes: memory stays flat through an upload
 * on the `upload` route and a download on the `serve` route of `server`, on Node, measured
 * as the adapters' flat-memory test measures. Client and server share the process, so the
 * client streams both bodies as well, and what it holds counts against the same bound.
 */
export function describeFlatMemory(
  server: HttpServer,
  configured: S3AdapterOptions | undefined,
  framework: MeasuringFramework,
): void {
  framework.describe(`${server.name} in flat memory`, () => {
    // As `describeServed` says, a run without the endpoint has no server to start.
    if (configured === undefined) {
      framework.test("(skipped: no S3 endpoint)", async () => {}, measurementTimeout);
      return;
    }

    framework.test(
      "an upload on the `upload` route",
      async () => await uploadInFlatMemory(server, configured),
      measurementTimeout,
    );
    framework.test(
      "a download on the `serve` route",
      async () => await downloadInFlatMemory(server, configured),
      measurementTimeout,
    );
  });
}

const largeKey = (): string => `flat-memory-${crypto.randomUUID()}/large.bin`;

async function uploadInFlatMemory(server: HttpServer, configured: S3AdapterOptions): Promise<void> {
  const storage = s3Storage(configured);
  const key = largeKey();
  // Spec 14.8's 1 MiB would refuse the object long before it shows anything.
  const started = await server.start(configured, { maxSize: Infinity });

  try {
    const meter = bufferMeter();
    const status = await streamedUpload(
      started.url("upload", key),
      generatedStream(objectSize, meter.sample),
    );

    meter.sample();

    assert(status === 201, `The upload answered ${status}`);
    assert((await storage.stat(key)).size === objectSize, "The upload stored another size");

    const growth = meter.growth();

    assert(growth <= uploadBound, `The upload held ${growth} bytes, more than ${uploadBound}`);
  } finally {
    await started.close();
    await storage.delete(key);
  }
}

async function downloadInFlatMemory(
  server: HttpServer,
  configured: S3AdapterOptions,
): Promise<void> {
  const storage = s3Storage(configured);
  const key = largeKey();

  await storage.put(key, generatedStream(objectSize));

  const started = await server.start(configured);

  try {
    const meter = bufferMeter();
    const response = await fetch(started.url("serve", key));

    assert(response.status === 200, `The download answered ${response.status}`);
    assert(response.body !== null, "The download answered no body");

    const read = await drain(response.body, meter.sample);

    assert(read === objectSize, `The download read ${read} of ${objectSize} bytes`);

    const growth = meter.growth();

    assert(
      growth <= downloadBound,
      `The download held ${growth} bytes, more than ${downloadBound}`,
    );
  } finally {
    await started.close();
    await storage.delete(key);
  }
}

/**
 * Sends `body` as a `PUT` without a length, a chunk once the last one was taken, and
 * answers the status. Not `fetch`: Node's holds a stream it sends whole, measured at 64,
 * 256 and 512 MiB for as many sent, which would count against the server.
 */
async function streamedUpload(url: URL, body: ReadableStream<Uint8Array>): Promise<number> {
  const sent = request(url, { method: "PUT" });
  const answered = once(sent, "response");

  for await (const chunk of body) {
    // oxlint-disable-next-line no-await-in-loop -- the next chunk waits for the server
    if (!sent.write(chunk)) await once(sent, "drain");
  }

  sent.end();

  // oxlint-disable-next-line no-unsafe-type-assertion -- `once` types the event's arguments as `any[]`
  const [response] = (await answered) as [IncomingMessage];

  response.resume();

  return response.statusCode ?? 0;
}
