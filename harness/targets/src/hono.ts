import { type Context, type Env, Hono } from "hono";

import type { S3Storage } from "../../../packages/adapter-s3/src/index.ts";
import { withStorage } from "../../../packages/hono/src/index.ts";
import { acceptUpload, redirectToObject, serveObject } from "../../../packages/http/src/index.ts";
import { presign, type RouteOptions, suiteRoutes } from "./routes.ts";

/** What a route reads besides the request: the storage `withStorage` set. */
type Routed = { Variables: { storage: S3Storage } };

/**
 * The methods spec 14.8 has the cases send to a route that hands each one to the layer.
 * `HEAD` is not among them: Hono routes it to the `GET` handler, and the layer reads
 * `c.req.raw.method`, which stays `"HEAD"` (spec 12).
 */
const sentMethods = ["GET", "POST", "PUT", "DELETE"];

/**
 * Spec 14.8's routes as an application of `@stowage/hono`, which `@hono/node-server`,
 * `Bun.serve`, `Deno.serve` and a worker's `fetch` each serve. It imports no `node:`
 * module, since the `workerd` cell bundles it at the flags of spec 1. `storage` is either
 * form `withStorage` takes: a worker builds it from `c.env` on every request.
 */
export function honoApp<E extends Env>(
  storage: S3Storage | ((c: Context<E>) => S3Storage),
  routes: RouteOptions = suiteRoutes,
): Hono<Routed> {
  return new Hono<Routed>()
    .use(withStorage("storage", storage))
    .on(
      sentMethods,
      "/serve/:key",
      async (c) => await serveObject(c.var.storage, c.req.param("key"), c.req.raw),
    )
    .on(
      sentMethods,
      "/redirect/:key",
      async (c) =>
        await redirectToObject(c.var.storage, c.req.param("key"), c.req.raw, { expiresIn: 60 }),
    )
    .on(
      sentMethods,
      "/upload/:key",
      async (c) =>
        await acceptUpload(c.var.storage, c.req.param("key"), c.req.raw, {
          maxSize: routes.maxSize,
        }),
    )
    .on(
      sentMethods,
      "/presign/:key",
      async (c) => await presign(c.var.storage, c.req.param("key"), c.req.raw),
    );
}
