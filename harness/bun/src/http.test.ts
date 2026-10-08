import { afterAll, describe, test } from "bun:test";

import { s3Storage } from "../../../packages/adapter-s3/src/index.ts";
import { serverStorage } from "../../s3/src/environment.ts";
import { honoApp } from "../../targets/src/hono.ts";
import { describeServers, type HttpServer, nodeBridge } from "../../targets/src/http.ts";
import { type RoutesHandler, routeUrls, routesOf } from "../../targets/src/routes.ts";

/**
 * Spec 2's Bun cell of `served`, on the runtime's own server.
 */
function onBunServe(served: string, answering: RoutesHandler): HttpServer {
  return {
    name: `${served} on \`Bun.serve\``,
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

const configured = serverStorage();
const close = await describeServers([bunServe, honoOnBunServe, nodeBridge], "Bun", configured, {
  describe,
  test,
});

afterAll(close);
