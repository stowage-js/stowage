import "server-only"; // oxlint-disable-line import/no-unassigned-import -- spec 16, see below

// The first line of the module that holds the storage (spec 16): Next.js aliases
// `server-only` and refuses a Client Component that imports this module.

import { fromEnv, s3Storage } from "@stowage/adapter-s3";
import { lazyStorage } from "@stowage/nextjs";

/**
 * The variable `name` of the server's environment. `next build` runs without the endpoint's
 * variables, so a storage constructed while the build evaluates this module fails it.
 */
function variable(name) {
  const value = process.env[name];

  if (value === undefined || value === "") throw new Error(`${name} is not set`);

  return value;
}

export const storage = lazyStorage(() =>
  s3Storage({
    bucket: variable("STOWAGE_S3_BUCKET"),
    region: variable("STOWAGE_S3_REGION"),
    endpoint: variable("STOWAGE_S3_ENDPOINT"),
    forcePathStyle: process.env.STOWAGE_S3_FORCE_PATH_STYLE === "true",
    credentials: fromEnv,
  }),
);

/** Spec 14.8's `maxSize` of the `upload` route, or what the harness started it with. */
export const maxSize = Number(process.env.STOWAGE_HTTP_MAX_SIZE ?? 1048576);

/** The key the catch-all segment holds, its segments decoded by Next.js and joined again. */
export async function keyOf(context) {
  const { key } = await context.params;

  return key.join("/");
}
