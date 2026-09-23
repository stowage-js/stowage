import { env } from "node:process";

import type { S3AdapterOptions } from "../../../packages/adapter-s3/src/index.ts";
import { fromEnv } from "../../../packages/adapter-s3/src/index.ts";
import { storageOptionsFrom } from "./configuration.ts";

/**
 * The endpoint as a runtime with `process.env` reads it: `start.sh` prints what a local
 * run exports, and `fromEnv` takes the credential from the same place.
 */
export function configuredStorage(): S3AdapterOptions | undefined {
  return storageOptionsFrom(env, fromEnv);
}

/** ADR 0012: a run without an endpoint fails rather than passing with the tier skipped. */
export function endpointOrFail(): S3AdapterOptions {
  const configured = configuredStorage();

  if (configured === undefined) throw new Error(endpointMissing);

  return configured;
}

export const endpointMissing = "No S3 endpoint is configured; see `harness/s3/README.md`";
