import { env } from "node:process";

import { afterAll, describe, test } from "bun:test";

import { s3Storage } from "../../../packages/adapter-s3/src/index.ts";
import { configuredStorage } from "../../s3/src/environment.ts";
import { endpointTiersFrom } from "../../targets/src/endpoints.ts";
import { honoApp } from "../../targets/src/hono.ts";
import { describeServers, type HttpServer, nodeBridge } from "../../targets/src/http.ts";
import { lengthOfCompleteBody, lengthZeroOnHead } from "../../targets/src/runtime-alterations.ts";
import { routeUrls, routesOf } from "../../targets/src/routes.ts";

/** Spec 2's Bun cell of `@stowage/http`, which runs on the runtime's own server. */
const bunServe: HttpServer = {
  name: "@stowage/http on `Bun.serve`",
  alterations: [lengthOfCompleteBody, lengthZeroOnHead],
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

/** Spec 2's Bun cell of `@stowage/hono`, whose answers `Bun.serve` changes as it does the layer's. */
const honoOnBunServe: HttpServer = {
  name: "@stowage/hono on `Bun.serve`",
  alterations: [lengthOfCompleteBody, lengthZeroOnHead],
  start: async (configured, routes) => {
    const server = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      fetch: honoApp(s3Storage(configured), routes).fetch,
    });

    return {
      url: routeUrls(`http://127.0.0.1:${server.port}`),
      close: async () => await server.stop(true),
    };
  },
};

const configured = endpointTiersFrom(env).has("s3") ? configuredStorage() : undefined;
const close = await describeServers([bunServe, honoOnBunServe, nodeBridge], "Bun", configured, {
  describe,
  test,
});

afterAll(close);
