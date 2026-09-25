import { env } from "node:process";

import type { AzureBlobAdapterOptions } from "../../../packages/adapter-azure-blob/src/index.ts";
import { fromEnv } from "../../../packages/adapter-azure-blob/src/index.ts";
import { storageOptionsFrom } from "./configuration.ts";
import { mintAccessToken } from "./token.ts";

/**
 * ADR 0023: every conformance case runs under an access token, the one scheme under which
 * everything the storage declares works. The resolver mints a fresh one for every request.
 */
export function configuredStorage(): AzureBlobAdapterOptions | undefined {
  return storageOptionsFrom(env, () => ({ accessToken: mintAccessToken() }));
}

/**
 * ADR 0023: the account key is promised as much as the token and checked by a test of the
 * adapter rather than the suite; `fromEnv` reads the key `start.sh` prints.
 */
export function storageUnderAccountKey(): AzureBlobAdapterOptions | undefined {
  return storageOptionsFrom(env, fromEnv);
}
