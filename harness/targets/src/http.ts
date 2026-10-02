import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";

import { type S3AdapterOptions, s3Storage } from "../../../packages/adapter-s3/src/index.ts";
import type { ConformanceFramework } from "../../../packages/conformance/src/describe.ts";
import { describeHttpConformance } from "../../../packages/conformance/src/describe-http.ts";
import type { HttpConformanceTarget } from "../../../packages/conformance/src/http-target.ts";
import { toWebRequest, writeResponse } from "../../../packages/http/src/index.ts";
import { type RouteOptions, routeUrls, routesOf } from "./routes.ts";

export interface ServedTarget {
  readonly target: HttpConformanceTarget;
  close(): Promise<void>;
}

/** The routes of spec 14.8 on a server that runs. */
export interface StartedServer {
  readonly url: HttpConformanceTarget["url"];
  close(): Promise<void>;
}

/**
 * A server of spec 2's second table, with `adapter-s3` behind it as ADR 0050 has every
 * server. Which runtime it runs on is the harness's to say, since the bridge on
 * `createServer` is one server on Node, Bun and Deno alike.
 */
export interface HttpServer {
  readonly name: string;
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
 * The HTTP suite against a server that runs, and one test saying why none does: ADR 0050
 * puts `adapter-s3` on SeaweedFS behind every server, so a run without that endpoint has no
 * server to start. Where the run asked for the endpoint, its check in `describeAdapters`
 * fails that run, which is the failure ADR 0012 asks for.
 */
export function describeServed(
  served: ServedTarget | undefined,
  framework: ConformanceFramework,
): void {
  if (served === undefined) {
    framework.test("the HTTP conformance suite (skipped: no S3 endpoint)", async () => {});
    return;
  }

  describeHttpConformance(served.target, framework);
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
      // `fetch` keeps its connections alive, which would hold `close` open until they idle out.
      server.closeAllConnections();
      await new Promise<void>((resolve, reject) =>
        server.close((error) => (error === undefined ? resolve() : reject(error))),
      );
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
