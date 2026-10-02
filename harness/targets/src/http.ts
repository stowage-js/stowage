import { createServer, type IncomingMessage, type ServerResponse } from "node:http";

import {
  type S3AdapterOptions,
  type S3Storage,
  s3Storage,
} from "../../../packages/adapter-s3/src/index.ts";
import type { ConformanceFramework } from "../../../packages/conformance/src/describe.ts";
import { describeHttpConformance } from "../../../packages/conformance/src/describe-http.ts";
import type { HttpConformanceTarget } from "../../../packages/conformance/src/http-target.ts";
import { serveObject, toWebRequest, writeResponse } from "../../../packages/http/src/index.ts";

export interface ServedTarget {
  readonly target: HttpConformanceTarget;
  close(): Promise<void>;
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
 * Spec 2's cells of `@stowage/http` and of the Node bridge on `node:http`'s `createServer`,
 * with `adapter-s3` behind the server as ADR 0050 has every server. The key travels as one
 * encoded path segment, so that a key holding `/`, `?` or `%` arrives as it was sent.
 */
export async function nodeBridgeTarget(configured: S3AdapterOptions): Promise<ServedTarget> {
  const storage = s3Storage(configured);
  const server = createServer((req, res) => void handle(storage, req, res));

  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));

  const address = server.address();

  if (address === null || typeof address === "string") throw new Error("No TCP port to reach");

  const origin = `http://127.0.0.1:${address.port}`;

  return {
    target: {
      name: "@stowage/http through the Node bridge",
      createStorage: () => s3Storage(configured),
      url: (route, key) => new URL(`/${route}/${encodeURIComponent(key)}`, origin),
    },
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
  req: IncomingMessage,
  res: ServerResponse,
): Promise<void> {
  try {
    await writeResponse(res, await answer(storage, req.url ?? "", toWebRequest(req, res)));
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
 * Spec 14.8 fixes what each route is configured with. The routes of the answers the layer
 * does not give yet answer `404`, so that a case reaching one fails on its status.
 */
async function answer(storage: S3Storage, url: string, request: Request): Promise<Response> {
  const [, route, encodedKey = ""] = routePattern.exec(url) ?? [];
  let key: string;

  try {
    key = decodeURIComponent(encodedKey);
  } catch {
    return new Response(null, { status: 404 });
  }

  if (route === "serve") return await serveObject(storage, key, request);

  return new Response(null, { status: 404 });
}
