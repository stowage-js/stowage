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

/** ADR 0012: a run without an endpoint fails rather than passing with the tier skipped. */
export function endpointOrFail(): S3AdapterOptions {
  const configured = configuredStorage();

  if (configured === undefined) {
    throw new Error("No S3 endpoint is configured; see `harness/s3/README.md`");
  }

  return configured;
}

/**
 * Spec 8.3: a credential the provider refuses. No identity is configured for it — a key
 * id no provider ever issued is refused by every one of them.
 */
export function storageWithBadCredentials(configured: S3AdapterOptions): S3AdapterOptions {
  return {
    ...configured,
    credentials: { accessKeyId: "stowage-no-such-identity", secretAccessKey: "nor-this-secret" },
  };
}

/**
 * Spec 8.3: a credential the provider accepts and refuses the write to. It reads and
 * lists and may not write, which is what tells the `403` that means this caller may not
 * do this from the two that fail to authenticate.
 */
export function storageWithDeniedCredentials(
  configured: S3AdapterOptions,
): S3AdapterOptions | undefined {
  const accessKeyId = env["STOWAGE_S3_DENIED_ACCESS_KEY_ID"];
  const secretAccessKey = env["STOWAGE_S3_DENIED_SECRET_ACCESS_KEY"];

  if (accessKeyId === undefined || accessKeyId === "") return undefined;
  if (secretAccessKey === undefined || secretAccessKey === "") return undefined;

  return { ...configured, credentials: { accessKeyId, secretAccessKey } };
}
