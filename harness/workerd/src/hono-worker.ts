import { s3Storage } from "../../../packages/adapter-s3/src/index.ts";
import type { Variables } from "../../s3/src/configuration.ts";
import { honoApp } from "../../targets/src/hono.ts";
import { routesFrom, storageOptionsOf } from "./http-bindings.ts";

let app: ReturnType<typeof honoApp> | undefined;

// Spec 2's `workerd` cell of `@stowage/hono`: the application of spec 14.8's routes as the
// worker, which builds its storage from `c.env` on every request, the form spec 12 names
// for `workerd`, where the credential arrives with the request.
export default {
  async fetch(request: Request, variables: Variables): Promise<Response> {
    app ??= honoApp<{ Bindings: Variables }>(
      (c) => s3Storage(storageOptionsOf(c.env)),
      routesFrom(variables),
    );

    return await app.fetch(request, variables);
  },
};
