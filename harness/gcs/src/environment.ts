import { env } from "node:process";

import { type GcsSigningStorage, gcsStorage } from "../../../packages/adapter-gcs/src/index.ts";
import { type GcsEndpoint, gcsEndpointFrom, scheduledAgainstBucket } from "./configuration.ts";

export type GcsBucket = Extract<GcsEndpoint, { readonly kind: "bucket" }>;

/** The endpoint the environment `start.sh` printed or the job names, or nothing where it is unset. */
export function configuredEndpoint(): GcsEndpoint | undefined {
  return gcsEndpointFrom(env);
}

/**
 * The real bucket where the scheduled job runs against it, which alone runs the tests the
 * suite does not assert (spec 10.4) and the probes of spec 14.
 */
export function scheduledBucket(): GcsBucket | undefined {
  const endpoint = configuredEndpoint();

  return endpoint?.kind === "bucket" && scheduledAgainstBucket(env) ? endpoint : undefined;
}

export function bucketOrFail(bucket: GcsBucket | undefined): GcsBucket {
  if (bucket === undefined) {
    throw new Error("No real GCS bucket is configured; see `harness/gcs/README.md`");
  }

  return bucket;
}

/** A storage under the bucket's resolvers, so that every storage built here shares their tokens. */
export function bucketStorage(bucket: GcsBucket): GcsSigningStorage {
  return gcsStorage({ ...bucket.options, signer: bucket.signer });
}
