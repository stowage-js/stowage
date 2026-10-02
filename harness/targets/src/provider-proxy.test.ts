import { createServer, type Server } from "node:http";

import { afterEach, expect, test } from "vitest";

import { type ProviderProxy, proxyTo } from "./provider-proxy.ts";

let provider: Server | undefined;
let proxy: ProviderProxy | undefined;

afterEach(async () => {
  await proxy?.close();
  provider?.closeAllConnections();
  await new Promise((resolve) => provider?.close(resolve));
});

/** A provider answering every request with `size` bytes, written as fast as they are taken. */
async function providerOf(size: number): Promise<string> {
  provider = createServer((_req, res) => {
    res.setHeader("content-length", size);
    res.end(new Uint8Array(size));
  });
  await new Promise<void>((resolve) => provider?.listen(0, "127.0.0.1", resolve));

  const address = provider.address();

  if (address === null || typeof address === "string") throw new Error("No TCP port to reach");

  return `http://127.0.0.1:${address.port}`;
}

test("relays a request and its answer, counting the bytes the provider sent", async () => {
  proxy = await proxyTo(await providerOf(1000));

  const response = await fetch(proxy.endpoint, { headers: { connection: "close" } });

  expect((await response.arrayBuffer()).byteLength).toBe(1000);

  await proxy.connections[0]?.closed;

  expect(proxy.connections).toHaveLength(1);
  // The status line and the headers come through the connection as well.
  expect(proxy.connections[0]?.relayed).toBeGreaterThan(1000);
});

test("resolves `closed` once the side of the provider's client closes", async () => {
  const size = 64 * 1024 * 1024;

  proxy = await proxyTo(await providerOf(size));

  const client = new AbortController();
  const response = await fetch(proxy.endpoint, { signal: client.signal });

  await response.body?.getReader().read();
  client.abort();
  await proxy.connections[0]?.closed;

  expect(proxy.connections[0]?.relayed).toBeLessThan(size);
});
