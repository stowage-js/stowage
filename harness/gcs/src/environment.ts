import { env } from "node:process";

import { type GcsEndpoint, gcsEndpointFrom } from "./configuration.ts";

/** The endpoint the environment `start.sh` printed or the job names, or nothing where it is unset. */
export function configuredEndpoint(): GcsEndpoint | undefined {
  return gcsEndpointFrom(env);
}
