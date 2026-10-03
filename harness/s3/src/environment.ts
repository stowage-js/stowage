import { env } from "node:process";

import type { S3AdapterOptions } from "../../../packages/adapter-s3/src/index.ts";
import { fromEnv } from "../../../packages/adapter-s3/src/index.ts";
import { endpointTiersFrom } from "../../targets/src/endpoints.ts";
import { runOptionsFrom } from "../../targets/src/run-options.ts";
import { servesBehindAServer, storageOptionsFrom } from "./configuration.ts";
import { endpointMissing } from "./target.ts";

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

/**
 * The endpoint where the scheduled run asks for both tiers, which is where spec 18 is
 * asked of it, and nothing on every commit.
 */
export function scheduledStorage(): S3AdapterOptions | undefined {
  return runOptionsFrom(env).includeSlow === true ? configuredStorage() : undefined;
}

/**
 * The endpoint behind the servers of spec 2's second table, where the run asks for the S3
 * tier and the endpoint is no real one: the scheduled run against AWS S3 or R2 leaves the
 * servers out, and its Bun and Deno jobs run them against SeaweedFS.
 */
export function serverStorage(): S3AdapterOptions | undefined {
  if (!endpointTiersFrom(env).has("s3") || !servesBehindAServer(env)) return undefined;

  return configuredStorage();
}
