import { env } from "node:process";

import { afterAll, describe, test } from "bun:test";

import { s3Storage } from "../../../packages/adapter-s3/src/index.ts";
import { configuredStorage } from "../../s3/src/environment.ts";
import { endpointTiersFrom } from "../../targets/src/endpoints.ts";
import { honoApp } from "../../targets/src/hono.ts";
import { describeServers, type HttpServer, nodeBridge } from "../../targets/src/http.ts";
import { lengthOfCompleteBody, lengthZeroOnHead } from "../../targets/src/runtime-alterations.ts";
import { type RoutesHandler, routeUrls, routesOf } from "../../targets/src/routes.ts";

/**
 * Spec 2's Bun cell of `served`, on the runtime's own server. It changes the answers of
 * `@stowage/hono` as it does the layer's, since Hono hands them on as they are.
 */
function onBunServe(served: string, answering: RoutesHandler): HttpServer {
  return {
    name: `${served} on \`Bun.serve\``,
    alterations: [lengthOfCompleteBody, lengthZeroOnHead],
    start: async (configured, routes) => {
      const server = Bun.serve({
        hostname: "127.0.0.1",
        port: 0,
        fetch: answering(s3Storage(configured), routes),
      });

      return {
        url: routeUrls(`http://127.0.0.1:${server.port}`),
        close: async () => await server.stop(true),
      };
    },
  };
}

const bunServe = onBunServe("@stowage/http", routesOf);
const honoOnBunServe = onBunServe(
  "@stowage/hono",
  (storage, routes) => honoApp(storage, routes).fetch,
);

const configured = endpointTiersFrom(env).has("s3") ? configuredStorage() : undefined;
const close = await describeServers([bunServe, honoOnBunServe, nodeBridge], "Bun", configured, {
  describe,
  test,
});

afterAll(close);
