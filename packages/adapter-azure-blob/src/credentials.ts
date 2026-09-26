import {
  readEnvironment,
  type Resolvable,
  type ResolverOptions,
  type StorageError,
} from "@stowage/core";

import { azureBlobError } from "./storage-error.ts";

/**
 * `accountKey` signs with Shared Key; `accessToken` is an Entra ID bearer token for the
 * scope `https://storage.azure.com/.default`, which the resolver obtained. The field
 * present decides, on every request anew. Checked before signing: exactly one of the two,
 * as a non-empty string, no other field, and an `accountKey` that decodes as base64.
 */
export type AzureBlobCredentials = { accountKey: string } | { accessToken: string };

const credentialFields: ReadonlySet<string> = new Set(["accountKey", "accessToken"]);

const accountKeyVariable = "AZURE_STORAGE_KEY";

/**
 * Spec 8.3: the credential is resolved before every request that is signed and nothing
 * is cached between calls, so a token the resolver renewed reaches the next request.
 */
export async function resolveCredentials(
  source: Resolvable<AzureBlobCredentials>,
  options: ResolverOptions,
): Promise<AzureBlobCredentials> {
  const resolved = typeof source === "function" ? await source(options) : source;

  return validate(resolved);
}

/**
 * A resolver, passed as `credentials: fromEnv` rather than called, so that a rotated key
 * reaches the next request. It reads neither the account, which is configuration, nor a
 * connection string or an access token (ADR 0021).
 */
export function fromEnv(_options?: ResolverOptions): { accountKey: string } {
  const accountKey = readEnvironment(accountKeyVariable);

  if (accountKey === "") {
    throw refusal(`The environment variable \`${accountKeyVariable}\` is empty`);
  }

  return { accountKey };
}

/** The bytes an account key stands for, which is what Shared Key signs with. */
export function accountKeyBytes(accountKey: string): Uint8Array<ArrayBuffer> {
  return Uint8Array.from(atob(accountKey), (character) => character.charCodeAt(0));
}

/**
 * Spec 8.3: checked before signing rather than a round trip later. An access token is
 * opaque and not parsed; an account key has to be one Shared Key can sign with.
 */
function validate(credentials: AzureBlobCredentials): AzureBlobCredentials {
  if (typeof credentials !== "object" || credentials === null) {
    throw refusal("The resolved credential is not an object");
  }

  const fields = Object.keys(credentials);
  const unknown = fields.find((field) => !credentialFields.has(field));

  if (unknown !== undefined) {
    throw refusal(`The credential field \`${unknown}\` is not one of the two Azure Blob takes`);
  }

  if (fields.length !== 1) {
    throw refusal(
      fields.length === 0
        ? "The credential holds neither `accountKey` nor `accessToken`"
        : "The credential holds both `accountKey` and `accessToken`, and takes one of them",
    );
  }

  if ("accountKey" in credentials) {
    requireFilled(credentials.accountKey, "accountKey");
    requireDecodable(credentials.accountKey);
  } else {
    requireFilled(credentials.accessToken, "accessToken");
  }

  return credentials;
}

function requireFilled(value: unknown, field: string): void {
  if (typeof value === "string" && value !== "") return;

  throw refusal(`The credential field \`${field}\` is empty or no string`);
}

function requireDecodable(accountKey: string): void {
  let bytes = 0;

  try {
    bytes = accountKeyBytes(accountKey).byteLength;
  } catch {
    // `atob` refuses what is no base64, which is the same refusal as no byte at all.
  }

  if (bytes > 0) return;

  throw refusal("The credential field `accountKey` does not decode as base64 to a key");
}

// The container and the operation belong to the storage that asked, which a resolver is
// written without; `inStorage` fills both in where the failure reaches one (spec 4.10).
function refusal(message: string): StorageError {
  return azureBlobError("", {
    code: "InvalidCredentials",
    message,
    operation: "credentials",
    attempts: 0,
  });
}
