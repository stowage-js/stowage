import { s3Storage } from "../../../packages/adapter-s3/src/index.ts";
import { serverStorage } from "../../s3/src/environment.ts";
import { honoApp } from "../../targets/src/hono.ts";
import { describeServers, type HttpServer, nodeBridge } from "../../targets/src/http.ts";
import { type RoutesHandler, routeUrls, routesOf } from "../../targets/src/routes.ts";
import { denoFramework } from "./framework.ts";

/**
 * Spec 2's Deno cell of `served`, on the runtime's own server.
 */
function onDenoServe(served: string, answering: RoutesHandler): HttpServer {
  return {
    name: `${served} on \`Deno.serve\``,
    start: async (configured, routes) => {
      const server = Deno.serve(
        { hostname: "127.0.0.1", port: 0, onListen: () => {} },
        answering(s3Storage(configured), routes),
      );

      return {
        url: routeUrls(`http://127.0.0.1:${server.addr.port}`),
        close: async () => await server.shutdown(),
      };
    },
  };
}

const denoServe = onDenoServe("@stowage/http", routesOf);
const honoOnDenoServe = onDenoServe(
  "@stowage/hono",
  (storage, routes) => honoApp(storage, routes).fetch,
);

const configured = serverStorage();

const close = await describeServers(
  [denoServe, honoOnDenoServe, nodeBridge],
  "Deno",
  configured,
  denoFramework,
);

// `Deno.test` has no `afterAll`, and runs tests in the order they were registered, so the
// servers close in a test of their own after the last one, as the suite's `cleanup` does.
denoFramework.test("close the servers", close);
