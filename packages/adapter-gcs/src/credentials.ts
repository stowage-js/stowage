import type { Resolvable, ResolverOptions, StorageError } from "@stowage/core";

import { gcsError } from "./storage-error.ts";

/**
 * The one form a credential takes, checked before a request goes out with it: `accessToken`
 * as a non-empty string and no other field; a violation is `InvalidCredentials` naming the
 * field. An object rather than a bare string, so that another form can join it later.
 */
export type GcsCredentials = {
  /**
   * An OAuth 2.0 bearer token for a scope that covers the operations, such as
   * `https://www.googleapis.com/auth/devstorage.read_write`, which the resolver obtained.
   * It is opaque and not parsed as a JWT.
   */
  accessToken: string;
};

/**
 * Spec 9.3: the credential is resolved before every request that carries it and nothing
 * is cached between calls, so a token the resolver renewed reaches the next request.
 */
export async function resolveCredentials(
  source: Resolvable<GcsCredentials>,
  options: ResolverOptions,
): Promise<GcsCredentials> {
  const resolved = typeof source === "function" ? await source(options) : source;

  return validate(resolved);
}

function validate(credentials: GcsCredentials): GcsCredentials {
  if (typeof credentials !== "object" || credentials === null) {
    throw refusal("The resolved credential is not an object");
  }

  const unknown = Object.keys(credentials).find((field) => field !== "accessToken");

  if (unknown !== undefined) {
    throw refusal(`The credential field \`${unknown}\` is not one Google Cloud Storage takes`);
  }

  if (typeof credentials.accessToken !== "string" || credentials.accessToken === "") {
    throw refusal("The credential field `accessToken` is missing, empty or no string");
  }

  return credentials;
}

// The bucket and the operation belong to the storage that asked, which a resolver is
// written without; `inStorage` fills both in where the failure reaches one (spec 4.10).
function refusal(message: string): StorageError {
  return gcsError("", {
    code: "InvalidCredentials",
    message,
    operation: "credentials",
    attempts: 0,
  });
}
