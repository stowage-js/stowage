import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";

import { type S3AdapterOptions, s3Storage } from "../../../packages/adapter-s3/src/index.ts";
import {
  type ConformanceFramework,
  describeCases,
} from "../../../packages/conformance/src/describe.ts";
import { httpConformanceCases } from "../../../packages/conformance/src/http-cases/index.ts";
import type { HttpConformanceTarget } from "../../../packages/conformance/src/http-target.ts";
import { casesOfTier } from "../../../packages/conformance/src/run.ts";
import { toWebRequest, writeResponse } from "../../../packages/http/src/index.ts";
import { describeDisconnect, type Runtime } from "./disconnect.ts";
import { type RouteOptions, routeUrls, routesOf } from "./routes.ts";
import { type AlteringServer, withServerAlterations } from "./server-alterations.ts";

export interface ServedTarget {
  readonly target: HttpConformanceTarget;
  close(): Promise<void>;
}

/** The routes of spec 14.8 on a server that runs. */
export interface StartedServer {
  readonly url: HttpConformanceTarget["url"];
  /**
   * For a server in a process of its own, which the harness's meter does not see: takes the
   * baseline of that process's buffer memory, and resolves to what answers its growth since.
   */
  meterApart?(): Promise<() => Promise<number>>;
  close(): Promise<void>;
}

/**
 * A server of spec 2's second table, with `adapter-s3` behind it as ADR 0050 has every
 * server. Which runtime it runs on is the harness's to say, since the bridge on
 * `createServer` is one server on Node, Bun and Deno alike.
 */
export interface HttpServer extends AlteringServer {
  start(storage: S3AdapterOptions, routes?: RouteOptions): Promise<StartedServer>;
}

/** The HTTP suite's target against `server`, started with the routes spec 14.8 fixes. */
export async function servedTarget(
  server: HttpServer,
  configured: S3AdapterOptions,
): Promise<ServedTarget> {
  const started = await server.start(configured);

  return {
    target: {
      name: server.name,
      createStorage: () => s3Storage(configured),
      url: started.url,
    },
    close: async () => await started.close(),
  };
}

/**
 * Spec 2's cells of `servers` on `runtime`: the HTTP suite against each server that runs,
 * and the disconnect test of spec 14.8 beside it, which a cell needs as much as the suite.
 * ADR 0050 puts `adapter-s3` on SeaweedFS behind every server, so a run without that
 * endpoint has no server to start, and one test per server says so; where the run asked
 * for the endpoint, its check in `describeAdapters` fails that run, which is the failure
 * ADR 0012 asks for. Resolves to what closes the servers once the run is over.
 */
export async function describeServers(
  servers: readonly HttpServer[],
  runtime: Runtime,
  configured: S3AdapterOptions | undefined,
  framework: ConformanceFramework,
): Promise<() => Promise<void>> {
  const served =
    configured === undefined
      ? []
      : await Promise.all(servers.map(async (server) => await servedTarget(server, configured)));

  for (const [index, server] of servers.entries()) {
    const target = served[index]?.target;

    if (target === undefined) {
      framework.test(`${server.name} over HTTP (skipped: no S3 endpoint)`, async () => {});
    } else {
      // `describeHttpConformance` takes no cases, and the server's alterations change what
      // the cases meet; the `describe` keeps the name it gives.
      describeCases(
        withServerAlterations(
          casesOfTier(httpConformanceCases, framework),
          server,
          target.url("serve", "").origin,
        ),
        target,
        framework,
        `${target.name} over HTTP`,
      );
    }

    describeDisconnect(server, runtime, configured, framework);
  }

  return async () => {
    await Promise.all(served.map(async (each) => await each.close()));
  };
}

/** Spec 2's cells of `@stowage/http` and of the Node bridge on `node:http`'s `createServer`. */
export const nodeBridge: HttpServer = {
  name: "@stowage/http through the Node bridge",
  start: async (configured, routes) => {
    const answer = routesOf(s3Storage(configured), routes);

    return await listening(createServer((req, res) => void handle(answer, req, res)));
  },
};

/** `server` listening on a free port of the loopback address, with the routes' URLs there. */
export async function listening(server: Server): Promise<StartedServer> {
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));

  const address = server.address();

  if (address === null || typeof address === "string") throw new Error("No TCP port to reach");

  return {
    url: routeUrls(`http://127.0.0.1:${address.port}`),
    close: async () => {
      const closed = new Promise<void>((resolve, reject) =>
        server.close((error) => (error === undefined ? resolve() : reject(error))),
      );

      // `fetch` keeps its connections alive, which would hold `close` open until they idle
      // out. After `close`, since Bun stops the server on `closeAllConnections` and its
      // `close` then fails as not running.
      server.closeAllConnections();
      await closed;
    },
  };
}

async function handle(
  answer: (request: Request) => Promise<Response>,
  req: IncomingMessage,
  res: ServerResponse,
): Promise<void> {
  try {
    await writeResponse(res, await answer(toWebRequest(req, res)));
  } catch (failure) {
    // The case would otherwise wait on an answer that never comes; the rejection still
    // reaches Vitest as an unhandled one, which fails the run with its stack.
    if (res.headersSent) {
      res.destroy();
    } else {
      res.statusCode = 500;
      res.end();
    }

    throw failure;
  }
}
