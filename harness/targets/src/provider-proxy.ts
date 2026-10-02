import { connect, createServer, type Socket } from "node:net";

/** One connection a server opened to the provider, as the proxy between them saw it. */
export interface ProxiedConnection {
  /** The bytes the provider sent through it so far, its status lines and headers among them. */
  readonly relayed: number;
  /** Resolves once the server's side of the connection closed. */
  readonly closed: Promise<void>;
}

export interface ProviderProxy {
  /** The endpoint a storage addresses to reach the provider through the proxy. */
  readonly endpoint: string;
  /** Every connection opened through the proxy, in the order they were opened. */
  readonly connections: readonly ProxiedConnection[];
  close(): Promise<void>;
}

/**
 * A TCP proxy in front of `endpoint`, which tells a test what no client of a server can
 * see: whether the server's connection to the provider closed, and how much of an object
 * had come through it by then (spec 14.8). It relays bytes as they are and reads none of
 * them, so a storage signs its requests for the proxy's host as for any other.
 */
export async function proxyTo(endpoint: string): Promise<ProviderProxy> {
  const provider = new URL(endpoint);
  const connections: ProxiedConnection[] = [];
  const sockets = new Set<Socket>();

  const proxy = createServer((client) => {
    const upstream = connect(Number(provider.port), provider.hostname);
    const closed = Promise.withResolvers<void>();
    const connection = { relayed: 0, closed: closed.promise };

    connections.push(connection);

    for (const socket of [client, upstream]) {
      sockets.add(socket);
      // A reset on either side is a closed connection here, not a failure of the proxy.
      socket.on("error", () => {});
      socket.on("close", () => sockets.delete(socket));
    }

    upstream.on("data", (chunk: Uint8Array) => void (connection.relayed += chunk.byteLength));
    client.pipe(upstream);
    upstream.pipe(client);
    client.on("close", () => {
      upstream.destroy();
      closed.resolve();
    });
    upstream.on("close", () => client.destroy());
  });

  await new Promise<void>((resolve) => proxy.listen(0, "127.0.0.1", resolve));

  const address = proxy.address();

  if (address === null || typeof address === "string") throw new Error("No TCP port to reach");

  return {
    endpoint: `${provider.protocol}//127.0.0.1:${address.port}`,
    connections,
    close: async () => {
      for (const socket of sockets) socket.destroy();
      await new Promise<void>((resolve, reject) =>
        proxy.close((error) => (error === undefined ? resolve() : reject(error))),
      );
    },
  };
}
