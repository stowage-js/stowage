import type { S3AdapterOptions, S3Credentials } from "../../../packages/adapter-s3/src/index.ts";
import { s3Storage } from "../../../packages/adapter-s3/src/index.ts";
import type { ConformanceFramework } from "../../../packages/conformance/src/describe.ts";
import type { ConformanceTarget } from "../../../packages/conformance/src/target.ts";
import { staleResolver } from "../../targets/src/stale-credentials.ts";
import {
  type ExpiredCredentials,
  expiredCredentialsFrom,
  staleCredentialsFrom,
  storageWithBadCredentials,
  storageWithDeniedCredentials,
  storageWithMissingBucket,
  type Variables,
} from "./configuration.ts";

/**
 * Past the expiration STS returned, before the token is handed out as expired: STS judges
 * it by the provider's clock, which the runner's may trail by a few seconds.
 */
const expiryMargin = 60_000;

/**
 * `adapter-s3` against the endpoint of ADR 0012, as every runtime's harness runs it. The
 * default cleanup of spec 14.2 is the one wanted: a fresh storage deleting below the prefix.
 */
export function s3Target(configured: S3AdapterOptions, variables: Variables): ConformanceTarget {
  const denied = storageWithDeniedCredentials(configured, variables);
  const expired = expiredCredentialsFrom(variables);
  const obtainStale = staleCredentialsFrom(configured, variables);

  return {
    name: "@stowage/adapter-s3",

    createStorage: () => s3Storage(configured),

    createStorageWithBadCredentials: () => s3Storage(storageWithBadCredentials(configured)),

    createStorageWithMissingBucket: () => s3Storage(storageWithMissingBucket(configured)),

    // Spec 14.2 keeps the case out of a run where the target supplies no factory, which is
    // what an endpoint without the second identity of `s3.json` leaves.
    ...(denied === undefined
      ? {}
      : { createStorageWithDeniedCredentials: () => s3Storage(denied) }),

    ...(expired === undefined
      ? {}
      : {
          createStorageWithExpiredCredentials: async () =>
            s3Storage({ ...configured, credentials: await onceExpired(expired) }),
        }),

    ...(obtainStale === undefined
      ? {}
      : {
          createStorageWithStaleCredentials: async (onRefresh) => {
            const stale = await onceExpired(await obtainStale());

            return s3Storage({
              ...configured,
              credentials: staleResolver(stale, configured.credentials, onRefresh),
            });
          },
        }),
  };
}

/**
 * ADR 0012: the `Expired` case starts from a credential that has already expired rather
 * than from one the rest of the suite happened to outlast, so the credential is handed out
 * once the expiration and the margin have passed.
 */
async function onceExpired(expired: ExpiredCredentials): Promise<S3Credentials> {
  const remaining = expired.expiresAt.getTime() + expiryMargin - Date.now();

  if (remaining > 0) await new Promise<void>((resolve) => void setTimeout(resolve, remaining));

  return expired.credentials;
}

export const endpointMissing = "No S3 endpoint is configured; see `harness/s3/README.md`";

/**
 * ADR 0012: a run includes this tier and fails where no endpoint is reachable rather than
 * passing with it skipped. One failure says so, in place of the same reason repeated over
 * every case the run then registers none of.
 */
export function describeEndpointCheck(
  framework: ConformanceFramework,
  configured: S3AdapterOptions | undefined,
): void {
  framework.test(
    "the S3 endpoint of ADR 0012 is configured (see `harness/s3/README.md`)",
    async () => {
      if (configured === undefined) throw new Error(endpointMissing);
    },
  );
}
