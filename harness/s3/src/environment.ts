import { env } from "node:process";

import type { S3AdapterOptions } from "../../../packages/adapter-s3/src/index.ts";
import { fromEnv } from "../../../packages/adapter-s3/src/index.ts";

/**
 * ADR 0012: the endpoint is configuration rather than a dependency, so the harness reads
 * a URL, a bucket and a credential from the environment and no case knows which server
 * answered. `start.sh` prints what a local run exports.
 */
export function configuredStorage(): S3AdapterOptions | undefined {
  const endpoint = env["STOWAGE_S3_ENDPOINT"];
  const bucket = env["STOWAGE_S3_BUCKET"];

  if (endpoint === undefined || endpoint === "" || bucket === undefined || bucket === "") {
    return undefined;
  }

  return {
    bucket,
    region: env["STOWAGE_S3_REGION"] ?? "us-east-1",
    endpoint,
    // The emulator answers on a loopback address, which no bucket name resolves in front
    // of; a real bucket is addressed virtual-hosted and leaves this unset.
    forcePathStyle: env["STOWAGE_S3_FORCE_PATH_STYLE"] === "true",
    credentials: fromEnv,
  };
}
