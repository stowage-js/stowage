import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { text } from "node:stream/consumers";

import {
  type S3AdapterOptions,
  type S3Storage,
  s3Storage,
} from "../../../packages/adapter-s3/src/index.ts";
import type { ConformanceFramework } from "../../../packages/conformance/src/describe.ts";
import { describeHttpConformance } from "../../../packages/conformance/src/describe-http.ts";
import type { HttpConformanceTarget } from "../../../packages/conformance/src/http-target.ts";
import {
  acceptUpload,
  presignUpload,
  redirectToObject,
  serveObject,
  toWebRequest,
  writeResponse,
} from "../../../packages/http/src/index.ts";

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
 * What a repository test may configure beyond spec 14.8's routes: the flat-memory test
 * uploads far more than the suite's 1 MiB.
 */
export interface RouteOptions {
  readonly maxSize: number;
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

/** Spec 14.8's `maxSize` of the `upload` and the `presign` route. */
const suiteMaxSize = 1048576;

const suiteRoutes: RouteOptions = { maxSize: suiteMaxSize };

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

/** The answers of spec 14.8, each the first segment of its route. */
const routePattern = /^\/(serve|redirect|upload|presign)\/([^/?]*)$/u;

/**
 * Spec 2's cells of `@stowage/http` and of the Node bridge on `node:http`'s `createServer`.
 * The key travels as one encoded path segment, so that a key holding `/`, `?` or `%`
 * arrives as it was sent.
 */
export const nodeBridge: HttpServer = {
  name: "@stowage/http through the Node bridge",
  start: async (configured, routes = suiteRoutes) => {
    const storage = s3Storage(configured);

    return await listening(createServer((req, res) => void handle(storage, routes, req, res)));
  },
};

/**
 * `server` listening on a free port of the loopback address, with the key of every route
 * as one encoded path segment.
 */
export async function listening(server: Server): Promise<StartedServer> {
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));

  const address = server.address();

  if (address === null || typeof address === "string") throw new Error("No TCP port to reach");

  const origin = `http://127.0.0.1:${address.port}`;

  return {
    url: (route, key) => new URL(`/${route}/${encodeURIComponent(key)}`, origin),
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
  storage: S3Storage,
  routes: RouteOptions,
  req: IncomingMessage,
  res: ServerResponse,
): Promise<void> {
  try {
    await writeResponse(res, await answer(storage, routes, req, res));
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

/**
 * Spec 14.8 fixes what each route is configured with, `routes` aside. Any other path
 * answers `404`.
 */
async function answer(
  storage: S3Storage,
  routes: RouteOptions,
  req: IncomingMessage,
  res: ServerResponse,
): Promise<Response> {
  const [, route, encodedKey = ""] = routePattern.exec(req.url ?? "") ?? [];
  let key: string;

  try {
    key = decodeURIComponent(encodedKey);
  } catch {
    return new Response(null, { status: 404 });
  }

  if (route === "serve") return await serveObject(storage, key, toWebRequest(req, res));
  if (route === "redirect") {
    return await redirectToObject(storage, key, toWebRequest(req, res), { expiresIn: 60 });
  }
  if (route === "upload") {
    return await acceptUpload(storage, key, toWebRequest(req, res), { maxSize: routes.maxSize });
  }
  if (route === "presign") return await presign(storage, key, req);

  return new Response(null, { status: 404 });
}

/**
 * Spec 14.8's `presign` route, which is the target's and not a protocol of the layer: it
 * answers any method but `POST` itself, and hands both values of the JSON body on as they
 * arrived, so that the layer's own checks of spec 10.6 are what a case meets.
 * `presignUpload` takes no `Request` (ADR 0049), so the route builds none and reads the
 * body from `req` alone, which no other reader competes for.
 */
async function presign(storage: S3Storage, key: string, req: IncomingMessage): Promise<Response> {
  if (req.method !== "POST") {
    return new Response(null, { status: 405, headers: { allow: "POST" } });
  }

  let values: unknown;

  try {
    values = JSON.parse(await text(req));
  } catch {
    return new Response(null, { status: 400 });
  }

  if (typeof values !== "object" || values === null || Array.isArray(values)) {
    return new Response(null, { status: 400 });
  }

  // oxlint-disable-next-line no-unsafe-type-assertion -- unchecked on purpose, as said above
  const { contentType, contentLength } = values as { contentType: string; contentLength: number };

  return await presignUpload(storage, key, {
    expiresIn: 60,
    maxSize: suiteMaxSize,
    contentType,
    contentLength,
  });
}
