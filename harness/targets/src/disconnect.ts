import { connect } from "node:net";

import { type S3AdapterOptions, s3Storage } from "../../../packages/adapter-s3/src/index.ts";
import { assert } from "../../../packages/conformance/src/assertions.ts";
import type { ConformanceFramework } from "../../../packages/conformance/src/describe.ts";
import type { HttpServer } from "./http.ts";
import { type ProviderProxy, proxyTo } from "./provider-proxy.ts";

/** The columns of spec 2. */
export type Runtime = "Node" | "Bun" | "Deno" | "workerd";

const mebibyte = 1024 * 1024;

/**
 * Far more than the socket buffers between the provider, the server and the client hold
 * together, so that a server reading on after the client left reads the object to its end
 * before the test gives up on it.
 */
const objectSize = 64 * mebibyte;

/** How long the server's connection to the provider may stay open after the client left. */
const defaultCloseTimeout = 10_000;

/**
 * Spec 14.8's first promise that no client observes: a client disconnecting during a `GET`
 * on the `serve` route cancels the stream `get` returned, and the cancel reaches the
 * provider's request (flow 4). A proxy between the server's storage and the provider sees
 * the server's connection close before the object came through it whole. A cell this
 * fails on carries no "yes" (spec 2), so it runs for every server on every runtime of its
 * cell; on `workerd` the server runs in a child process and `runtime` is not the harness's.
 */
export function describeDisconnect(
  server: HttpServer,
  runtime: Runtime,
  configured: S3AdapterOptions | undefined,
  framework: ConformanceFramework,
): void {
  const name = `${server.name} on ${runtime}: a client disconnecting during a \`GET\` reaches the provider`;

  // As `describeServed` says, a run without the endpoint has no server to start.
  if (configured === undefined) {
    framework.test(`${name} (skipped: no S3 endpoint)`, async () => {});
    return;
  }

  framework.test(name, async () => await disconnectDuringGet(server, configured));
}

/**
 * The check behind `describeDisconnect`, which rejects where the server's connection to
 * the provider stayed open `closeTimeout` after the client left or carried the whole object.
 */
export async function disconnectDuringGet(
  server: HttpServer,
  configured: S3AdapterOptions,
  closeTimeout: number = defaultCloseTimeout,
): Promise<void> {
  const storage = s3Storage(configured);
  const key = `disconnect-${crypto.randomUUID()}/large.bin`;

  await storage.put(key, new Uint8Array(objectSize));

  const proxy = await proxyTo(endpointOf(configured));
  const started = await server.start({ ...configured, endpoint: proxy.endpoint });

  try {
    await leaveAfterFirstBytes(started.url("serve", key));

    const { closed, relayed } = await connectionsWithin(proxy, closeTimeout);

    assert(
      relayed < objectSize,
      `The server read all ${objectSize} bytes from the provider after the client left`,
    );
    assert(
      closed,
      `The server's connection to the provider stayed open ${closeTimeout} ms after the client left, ${relayed} of ${objectSize} bytes relayed`,
    );
  } finally {
    await started.close();
    await proxy.close();
    await storage.delete(key);
  }
}

function endpointOf(configured: S3AdapterOptions): string {
  if (configured.endpoint === undefined) {
    throw new Error("A server runs against an endpoint of its own (ADR 0050), and none is set");
  }

  return configured.endpoint;
}

/**
 * Sends a `GET` over a socket of its own and destroys the socket once the first bytes of a
 * `200` arrived, the way a browser tab closing leaves: `fetch` would leave when its runtime
 * chooses, and a reader of its body may buffer ahead.
 */
async function leaveAfterFirstBytes(url: URL): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const socket = connect(Number(url.port), url.hostname, () => {
      socket.write(`GET ${url.pathname} HTTP/1.1\r\nHost: ${url.host}\r\n\r\n`);
    });

    socket.once("data", (chunk: Uint8Array) => {
      const statusLine = new TextDecoder().decode(chunk).split("\r\n", 1)[0];

      socket.destroy();

      if (statusLine === "HTTP/1.1 200 OK") resolve();
      else reject(new Error(`The server answered the \`GET\` with \`${statusLine}\``));
    });
    socket.once("error", reject);
    socket.once("close", () => reject(new Error("The server closed before sending any data")));
  });
}

/**
 * Whether every connection the server opened to the provider closed within `timeout`, and
 * the bytes the provider sent through them by then. A connection still open is a server
 * that stopped reading and kept the provider's request alive.
 */
async function connectionsWithin(
  proxy: ProviderProxy,
  timeout: number,
): Promise<{ closed: boolean; relayed: number }> {
  const { connections } = proxy;

  assert(connections.length > 0, "The server opened no connection to the provider");

  let timer: ReturnType<typeof setTimeout> | undefined;
  const closed = await Promise.race([
    Promise.all(connections.map(async (connection) => await connection.closed)).then(() => true),
    new Promise<false>((resolve) => void (timer = setTimeout(() => resolve(false), timeout))),
  ]);

  clearTimeout(timer);

  return { closed, relayed: connections.reduce((sum, { relayed }) => sum + relayed, 0) };
}
