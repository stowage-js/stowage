import {
  readEnvironment,
  type Resolvable,
  type ResolverOptions,
  type StorageError,
} from "@stowage/core";

import { s3Error } from "./storage-error.ts";

/**
 * Checked before signing: `accessKeyId` and `secretAccessKey` are non-empty strings, and no
 * key beyond these three is present. A violation is `InvalidCredentials` naming the field.
 */
export interface S3Credentials {
  accessKeyId: string;
  secretAccessKey: string;
  sessionToken?: string;
}

/** The three fields spec 7.1 names, and the whole set a resolved credential may carry. */
const credentialFields: ReadonlySet<string> = new Set([
  "accessKeyId",
  "secretAccessKey",
  "sessionToken",
]);

const accessKeyIdVariable = "AWS_ACCESS_KEY_ID";
const secretAccessKeyVariable = "AWS_SECRET_ACCESS_KEY";
const sessionTokenVariable = "AWS_SESSION_TOKEN";

/**
 * Spec 7.3: the credential is resolved before every request that is signed and nothing
 * is cached between calls, so a rotation the resolver performs reaches the next request.
 */
export async function resolveCredentials(
  source: Resolvable<S3Credentials>,
  options: ResolverOptions,
): Promise<S3Credentials> {
  const resolved = typeof source === "function" ? await source(options) : source;

  return validate(resolved);
}

/**
 * A resolver, passed as `credentials: fromEnv` rather than called, so that a rotated
 * `AWS_SESSION_TOKEN` reaches the next request. Reading the three variables again is
 * what a refresh is here, so the options it is handed decide nothing (ADR 0007).
 */
export function fromEnv(_options?: ResolverOptions): S3Credentials {
  const accessKeyId = readEnvironment(accessKeyIdVariable);
  const secretAccessKey = readEnvironment(secretAccessKeyVariable);
  const sessionToken = readEnvironment(sessionTokenVariable);

  if (accessKeyId === "") throw emptyVariable(accessKeyIdVariable);
  if (secretAccessKey === "") throw emptyVariable(secretAccessKeyVariable);

  return sessionToken === ""
    ? { accessKeyId, secretAccessKey }
    : { accessKeyId, secretAccessKey, sessionToken };
}

/**
 * Spec 7.3: both required fields are non-empty strings and every key of the resolved
 * object is one of the three, checked before signing rather than a round trip later.
 */
function validate(credentials: S3Credentials): S3Credentials {
  if (typeof credentials !== "object" || credentials === null) {
    throw refusal("The resolved credential is not an object");
  }

  for (const field of Object.keys(credentials)) {
    if (!credentialFields.has(field)) {
      throw refusal(`The credential field \`${field}\` is not one of the three S3 takes`);
    }
  }

  requireFilled(credentials.accessKeyId, "accessKeyId");
  requireFilled(credentials.secretAccessKey, "secretAccessKey");

  return credentials;
}

function requireFilled(value: string, field: string): void {
  if (typeof value === "string" && value !== "") return;

  throw refusal(`The credential field \`${field}\` is empty`);
}

function emptyVariable(name: string): StorageError {
  return refusal(`The environment variable \`${name}\` is empty`);
}

// The bucket and the operation belong to the storage that asked, which a resolver is
// written without; `inStorage` fills both in where the failure reaches one (spec 4.10).
function refusal(message: string): StorageError {
  return s3Error("", {
    code: "InvalidCredentials",
    message,
    operation: "credentials",
    attempts: 0,
  });
}
