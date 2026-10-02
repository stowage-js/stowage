import { env } from "node:process";

import { afterAll, describe, test } from "bun:test";

import { s3Storage } from "../../../packages/adapter-s3/src/index.ts";
import { configuredStorage } from "../../s3/src/environment.ts";
import { endpointTiersFrom } from "../../targets/src/endpoints.ts";
import { describeServers, type HttpServer, nodeBridge } from "../../targets/src/http.ts";
import { routeUrls, routesOf } from "../../targets/src/routes.ts";

/** Spec 2's Bun cell of `@stowage/http`, which runs on the runtime's own server. */
const bunServe: HttpServer = {
  name: "@stowage/http on `Bun.serve`",
  divergences: [
    {
      case: "serve/whole",
      differs:
        "`Bun.serve` sends `Content-Length` with a body that is complete before the headers are written, as the 16 bytes of the case are",
      failureMessagePart: '`GET` carries `content-length: "16"` and not null',
    },
    {
      case: "serve/head",
      differs:
        "`Bun.serve` answers a `HEAD` the layer left without a body and without `Content-Length` with `Content-Length: 0`",
      failureMessagePart: '`HEAD` carries `content-length: "0"` and not null',
    },
  ],
  start: async (configured, routes) => {
    const server = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      fetch: routesOf(s3Storage(configured), routes),
    });

    return {
      url: routeUrls(`http://127.0.0.1:${server.port}`),
      close: async () => await server.stop(true),
    };
  },
};

const configured = endpointTiersFrom(env).has("s3") ? configuredStorage() : undefined;
const close = await describeServers([bunServe, nodeBridge], "Bun", configured, {
  describe,
  test,
});

afterAll(close);
