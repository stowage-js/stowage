import { env } from "node:process";

import { s3Storage } from "../../../packages/adapter-s3/src/index.ts";
import { configuredStorage } from "../../s3/src/environment.ts";
import { endpointTiersFrom } from "../../targets/src/endpoints.ts";
import { describeServers, type HttpServer, nodeBridge } from "../../targets/src/http.ts";
import { routeUrls, routesOf } from "../../targets/src/routes.ts";
import { lengthZeroOnHead } from "../../targets/src/runtime-alterations.ts";
import { denoFramework } from "./framework.ts";

/** Spec 2's Deno cell of `@stowage/http`, which runs on the runtime's own server. */
const denoServe: HttpServer = {
  name: "@stowage/http on `Deno.serve`",
  alterations: [lengthZeroOnHead],
  start: async (configured, routes) => {
    const server = Deno.serve(
      { hostname: "127.0.0.1", port: 0, onListen: () => {} },
      routesOf(s3Storage(configured), routes),
    );

    return {
      url: routeUrls(`http://127.0.0.1:${server.addr.port}`),
      close: async () => await server.shutdown(),
    };
  },
};

const configured = endpointTiersFrom(env).has("s3") ? configuredStorage() : undefined;

await describeServers([denoServe, nodeBridge], "Deno", configured, denoFramework);
