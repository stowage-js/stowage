import { createServer } from "node:http";

import { getRequestListener } from "@hono/node-server";

import { s3Storage } from "../../../packages/adapter-s3/src/index.ts";
import { honoApp } from "./hono.ts";
import { type HttpServer, listening } from "./http.ts";

/**
 * Spec 2's Node cell of `@stowage/hono`, on the listener `serve()` of `@hono/node-server`
 * hands `node:http`'s `createServer`; called alone, it is typed as that server and not as
 * the HTTP/2 one `serve()` may build. Like `serve()`, it replaces the global `Request` and
 * `Response` with subclasses of its own, which the layer then builds its answers with.
 */
export const honoNodeServer: HttpServer = {
  name: "@stowage/hono on `@hono/node-server`",
  start: async (configured, routes) =>
    await listening(createServer(getRequestListener(honoApp(s3Storage(configured), routes).fetch))),
};
