import { createServer, request } from "node:http";

import { afterEach, beforeEach, expect, test, vi } from "vitest";

import { generatedStream } from "./buffer-meter.ts";
import { describeFlatMemory } from "./flat-memory.ts";
import { type HttpServer, listening, type StartedServer } from "./http.ts";

const storage = vi.hoisted(() => ({
  put: vi.fn<() => Promise<void>>(async () => {}),
  delete: vi.fn<() => Promise<void>>(async () => {}),
  stat: vi.fn<() => Promise<{ size: number }>>(async () => ({ size: 1024 ** 3 })),
}));
vi.mock("../../../packages/adapter-s3/src/index.ts", () => ({ s3Storage: () => storage }));
vi.mock("node:http", async (importOriginal) => {
  const original = await importOriginal<typeof import("node:http")>();

  return { ...original, request: vi.fn<typeof request>(original.request) };
});
vi.mock("./buffer-meter.ts", () => ({
  mebibyte: 1024 ** 2,
  defaultPartSize: 8 * 1024 ** 2,
  defaultConcurrency: 4,
  bufferMeter: () => ({ sample: () => {}, growth: () => 0 }),
  generatedStream: vi.fn<typeof generatedStream>(
    () => new ReadableStream<Uint8Array>({ start: (c) => c.close() }),
  ),
  drain: async () => 1024 ** 3,
}));

const configured = {
  bucket: "test",
  region: "test",
  credentials: { accessKeyId: "test", secretAccessKey: "test" },
};

function measurement(server: HttpServer, route: "upload" | "serve"): () => Promise<void> {
  let run: (() => Promise<void>) | undefined;

  describeFlatMemory(server, configured, {
    describe: (_name, body) => body(),
    test: (name, body) => {
      if (name.includes(`\`${route}\``)) run = body;
    },
  });
  if (run === undefined) throw new Error("No measurement registered");
  return run;
}

let started: StartedServer | undefined;

beforeEach(() => vi.clearAllMocks());
afterEach(async () => {
  vi.unstubAllGlobals();
  await started?.close();
  started = undefined;
});

test.each(["put", "start", "close"])("deletes the seeded key when %s fails", async (stage) => {
  const failure = new Error(`${stage} failed`);
  const close = vi.fn<() => Promise<void>>(async () => {});
  const start = vi.fn<HttpServer["start"]>(async () => ({
    url: () => new URL("http://127.0.0.1:1"),
    close,
  }));

  vi.stubGlobal("fetch", async () => new Response("body"));
  if (stage === "put") storage.put.mockRejectedValueOnce(failure);
  if (stage === "start") start.mockRejectedValueOnce(failure);
  if (stage === "close") close.mockRejectedValueOnce(failure);

  await expect(measurement({ name: "test", start }, "serve")()).rejects.toBe(failure);
  expect(storage.delete).toHaveBeenCalledExactlyOnceWith(
    expect.stringMatching(/^flat-memory-.*\/large.bin$/u),
  );
  expect(start).toHaveBeenCalledTimes(stage === "put" ? 0 : 1);
  expect(close).toHaveBeenCalledTimes(stage === "close" ? 1 : 0);
});

test("destroys the request when reading the upload body fails", async () => {
  const failure = new Error("body failed");

  started = await listening(createServer((req) => req.resume()));
  const running = started;
  const server = {
    name: "test",
    start: async () => ({ ...running, close: async () => {} }),
  };

  vi.mocked(generatedStream).mockReturnValueOnce(
    new ReadableStream({ start: (controller) => controller.error(failure) }),
  );

  await expect(measurement(server, "upload")()).rejects.toBe(failure);
  expect(vi.mocked(request).mock.results[0]?.value.destroyed).toBe(true);
});

test("handles a request error while waiting for drain without an unhandled rejection", async () => {
  started = await listening(createServer((req) => req.socket.destroy()));
  const running = started;
  const server = {
    name: "test",
    start: async () => ({ ...running, close: async () => {} }),
  };

  vi.mocked(generatedStream).mockReturnValueOnce(
    new ReadableStream({ pull: (controller) => controller.enqueue(new Uint8Array(1024 ** 2)) }),
  );

  await expect(measurement(server, "upload")()).rejects.toThrow(/socket hang up|ECONNRESET|EPIPE/u);
  expect(vi.mocked(request).mock.results[0]?.value.destroyed).toBe(true);
});

test("ends the request after successfully writing the whole body", async () => {
  const chunks: Uint8Array[] = [];

  started = await listening(
    createServer((req, res) => {
      req.on("data", (chunk: Uint8Array) => chunks.push(chunk));
      req.on("end", () => res.writeHead(201).end());
    }),
  );
  const running = started;
  const server = {
    name: "test",
    start: async () => ({ ...running, close: async () => {} }),
  };

  vi.mocked(generatedStream).mockReturnValueOnce(
    new ReadableStream({
      start(controller) {
        controller.enqueue(new Uint8Array([1, 2, 3]));
        controller.close();
      },
    }),
  );

  await measurement(server, "upload")();
  expect(Buffer.concat(chunks)).toEqual(Buffer.from([1, 2, 3]));
});

/** A server in a process of its own, `next start`, whose process grew by `mebibytes`. */
function serverApart(mebibytes: number): HttpServer {
  return {
    name: "test",
    start: async () => ({
      url: () => new URL("http://127.0.0.1:1"),
      meterApart: async () => async () => mebibytes * 1024 ** 2,
      close: async () => {},
    }),
  };
}

test("bounds a download through a server apart once for each process", async () => {
  vi.stubGlobal("fetch", async () => new Response("body"));

  await expect(measurement(serverApart(100), "serve")()).resolves.toBeUndefined();
});

test("counts what a server apart holds against that bound", async () => {
  vi.stubGlobal("fetch", async () => new Response("body"));

  await expect(measurement(serverApart(129), "serve")()).rejects.toThrow(
    /held 135266304 bytes, more than 134217728/u,
  );
});
