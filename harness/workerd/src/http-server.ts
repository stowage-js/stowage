import { once } from "node:events";

import type { S3AdapterOptions } from "../../../packages/adapter-s3/src/index.ts";
import type { HttpServer } from "../../targets/src/http.ts";
import { routeUrls } from "../../targets/src/routes.ts";
import { listeningPorts, spawnWorkerd } from "./workerd-process.ts";

/** The configs of `http.capnp`. */
export type HttpConfig = "spec" | "defaults";

const names: Record<HttpConfig, string> = {
  spec: "@stowage/http on `workerd`'s `fetch`",
  defaults: "@stowage/http on `workerd`'s `fetch` at the default flags",
};

/**
 * Spec 2's `workerd` cell of `@stowage/http`, which runs in a `workerd` of its own for every
 * start: the storage it is started with reaches the worker as bindings, the endpoint a test
 * put a proxy in front of among them.
 */
export function workerdServer(config: HttpConfig): HttpServer {
  return {
    name: names[config],
    divergences: [
      {
        case: "serve/range",
        differs:
          "`workerd` drops the `Content-Length` of every answer whose body is a `ReadableStream`, a `206` among them, and sends it chunked",
        failureMessagePart: '`Range: bytes=2-5` carries `content-length: null` and not "4"',
      },
    ],
    start: async (configured, routes) => {
      const child = spawnWorkerd(["http.capnp", config], {
        ...(await variablesOf(configured)),
        ...(routes === undefined ? {} : { STOWAGE_HTTP_MAX_SIZE: String(routes.maxSize) }),
      });
      const exited = once(child, "exit").catch(() => {});
      const { http } = await listeningPorts(child, ["http"]);

      return {
        url: routeUrls(`http://127.0.0.1:${http}`),
        close: async () => {
          child.kill();
          await exited;
        },
      };
    },
  };
}

/** The variables `start.sh` prints, which the bindings of `http.capnp` read. */
async function variablesOf(configured: S3AdapterOptions): Promise<Record<string, string>> {
  const { credentials } = configured;
  const { accessKeyId, secretAccessKey } =
    typeof credentials === "function" ? await credentials() : credentials;

  return {
    STOWAGE_S3_ENDPOINT: configured.endpoint ?? "",
    STOWAGE_S3_BUCKET: configured.bucket,
    STOWAGE_S3_REGION: configured.region,
    STOWAGE_S3_FORCE_PATH_STYLE: String(configured.forcePathStyle ?? false),
    AWS_ACCESS_KEY_ID: accessKeyId,
    AWS_SECRET_ACCESS_KEY: secretAccessKey,
  };
}
