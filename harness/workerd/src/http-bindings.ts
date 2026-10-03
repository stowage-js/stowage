import type { S3AdapterOptions } from "../../../packages/adapter-s3/src/index.ts";
import { storageOptionsFrom, type Variables } from "../../s3/src/configuration.ts";
import type { RouteOptions } from "../../targets/src/routes.ts";

/** As in `src/worker.ts`, the credential arrives as two bindings beside the endpoint. */
export function storageOptionsOf(variables: Variables): S3AdapterOptions {
  const configured = storageOptionsFrom(variables, {
    accessKeyId: variables["AWS_ACCESS_KEY_ID"] ?? "",
    secretAccessKey: variables["AWS_SECRET_ACCESS_KEY"] ?? "",
  });

  if (configured === undefined) throw new Error("The worker was started without an S3 endpoint");

  return configured;
}

/** The routes a repository test configured beyond spec 14.8's, which `http.capnp` binds. */
export function routesFrom(variables: Variables): RouteOptions | undefined {
  const maxSize = variables["STOWAGE_HTTP_MAX_SIZE"];

  return maxSize === undefined || maxSize === null ? undefined : { maxSize: Number(maxSize) };
}
