import { createServer } from "node:http";

import { expect, test, vi } from "vitest";

import { disconnectDuringGet } from "./disconnect.ts";
import { listening } from "./http.ts";

vi.mock("../../../packages/adapter-s3/src/index.ts", () => ({
  s3Storage: () => ({ put: async () => {}, delete: async () => {} }),
}));
vi.mock("./provider-proxy.ts", () => ({
  proxyTo: async () => ({
    endpoint: "http://127.0.0.1:1",
    connections: [{ closed: Promise.resolve(), relayed: 1 }],
    close: async () => {},
  }),
}));

const configured = {
  bucket: "test",
  region: "test",
  endpoint: "http://127.0.0.1:1",
  credentials: { accessKeyId: "test", secretAccessKey: "test" },
};

test("rejects when the server closes cleanly before sending data", async () => {
  const server = {
    name: "closes without data",
    start: async () => await listening(createServer((req) => req.socket.end())),
  };

  await expect(disconnectDuringGet(server, configured)).rejects.toThrow(
    "The server closed before sending any data",
  );
});

function answeringServer(status: number) {
  return {
    name: "answers then closes",
    start: async () =>
      await listening(createServer((_req, res) => res.writeHead(status).end("body"))),
  };
}

test("resolves on a successful response followed by close", async () => {
  await expect(disconnectDuringGet(answeringServer(200), configured)).resolves.toBeUndefined();
});

test("preserves a failed status when the socket closes", async () => {
  await expect(disconnectDuringGet(answeringServer(503), configured)).rejects.toThrow(
    "HTTP/1.1 503 Service Unavailable",
  );
});
