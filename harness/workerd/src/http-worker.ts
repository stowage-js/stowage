import { type S3AdapterOptions, s3Storage } from "../../../packages/adapter-s3/src/index.ts";
import * as http from "../../../packages/http/src/index.ts";
import { storageOptionsFrom, type Variables } from "../../s3/src/configuration.ts";
import { type RouteOptions, routesOf } from "../../targets/src/routes.ts";
import { nodeApiReach } from "./node-api.ts";

let answer: ((request: Request) => Promise<Response>) | undefined;

// Spec 2's `workerd` cell of `@stowage/http`: the routes of spec 14.8 in a worker's `fetch`,
// with `adapter-s3` behind them, for the cases to reach from the Node harness.
export default {
  async fetch(request: Request, variables: Variables): Promise<Response> {
    // Spec 10.7: the package loads here whole, although the Node bridge has nothing to do
    // here. Reading the names keeps every export in the bundle, the bridge's among them.
    const { pathname } = new URL(request.url);

    if (pathname === "/exports") return Response.json(Object.keys(http).toSorted());
    if (pathname === "/node-api") return Response.json(await nodeApiReach());

    answer ??= routesOf(s3Storage(storageOptionsOf(variables)), routesFrom(variables));

    return await answer(request);
  },
};

/** As in `src/worker.ts`, the credential arrives as two bindings beside the endpoint. */
function storageOptionsOf(variables: Variables): S3AdapterOptions {
  const configured = storageOptionsFrom(variables, {
    accessKeyId: variables["AWS_ACCESS_KEY_ID"] ?? "",
    secretAccessKey: variables["AWS_SECRET_ACCESS_KEY"] ?? "",
  });

  if (configured === undefined) throw new Error("The worker was started without an S3 endpoint");

  return configured;
}

function routesFrom(variables: Variables): RouteOptions | undefined {
  const maxSize = variables["STOWAGE_HTTP_MAX_SIZE"];

  return maxSize === undefined || maxSize === null ? undefined : { maxSize: Number(maxSize) };
}
