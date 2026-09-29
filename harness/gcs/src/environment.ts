import { env } from "node:process";

import type { GcsAdapterOptions } from "../../../packages/adapter-gcs/src/index.ts";
import { storageOptionsFrom } from "./configuration.ts";

/** The storage the environment `start.sh` printed names, or nothing where it is unset. */
export function configuredStorage(): GcsAdapterOptions | undefined {
  return storageOptionsFrom(env);
}
