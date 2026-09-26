import type { PresignedPut } from "@stowage/core";

import type { AzureBlobConfiguration } from "./configuration.ts";
import { type AzureBlobCredentials, resolveCredentials } from "./credentials.ts";
import { requireKey } from "./key.ts";
import {
  optionError,
  presignGetOptionKeys,
  presignPutOptionKeys,
  requireKnownOptions,
} from "./options.ts";
import { blobUrl } from "./request.ts";
import {
  type ResponseOverrides,
  sasLead,
  type SasGrant,
  sasTime,
  type SignedSas,
  signServiceSas,
  signUserDelegationSas,
  type UserDelegationSasGrant,
} from "./sas.ts";
import { azureBlobError, inStorage } from "./storage-error.ts";
import { requestUserDelegationKey } from "./user-delegation-key.ts";

export interface AzureBlobPresignGetOptions {
  /** Seconds, 1 to 604800. */
  expiresIn: number;
  responseContentType?: string;
  responseContentDisposition?: string;
  responseCacheControl?: string;
}

export interface AzureBlobPresignPutOptions {
  /** Seconds, 1 to 604800. */
  expiresIn: number;
  /** Bound exactly, case and parameters included: an upload of another type is refused. */
  contentType: string;
  /**
   * Bound exactly, so the client reports the length and the server signs that number. A
   * finite, non-negative integer; anything else is `InvalidOption` before anything is sent.
   */
  contentLength: number;
}

/** Spec 8.9: a `PUT` creates a block blob only when it names the type. */
const blockBlob = "BlockBlob";

/** ADR 0022: the seven days a user delegation key may live, and the ceiling of spec 7.10. */
const longestLifetime = 604_800;

/** Each override of spec 8.9 and the field of the grant that carries it into the SAS. */
const responseOverrides = [
  ["responseCacheControl", "cacheControl"],
  ["responseContentDisposition", "contentDisposition"],
  ["responseContentType", "contentType"],
] as const;

/** Spec 8.9: `sp=r` on an addressable key, the overrides carried as `rscc`, `rscd`, `rsct`. */
export async function presignGet(
  configuration: AzureBlobConfiguration,
  key: string,
  options: AzureBlobPresignGetOptions,
): Promise<string> {
  const operation = "presignGet";

  requireKey(configuration.container, key, "addressable", operation);

  const given = readGroup(configuration.container, options, presignGetOptionKeys, operation);
  const expiresIn = readExpiresIn(configuration.container, given.expiresIn, operation);
  const overrides: { -readonly [field in keyof ResponseOverrides]: string } = {};

  for (const [option, field] of responseOverrides) {
    const value = given[option];

    if (value === undefined) continue;

    overrides[field] = readText(configuration.container, value, option, operation);
  }

  const grant = { key, permissions: "r", ...window(expiresIn), overrides };
  const credentials = await resolve(configuration, operation, key);
  const sas =
    "accountKey" in credentials
      ? await signServiceSas(configuration, grant, credentials.accountKey)
      : await signUnderDelegation(configuration, grant, operation);

  return blobUrl(configuration, key, sas.query);
}

/**
 * Spec 8.9: `sp=w` on a writable key, under an access token alone, since a service SAS
 * binds no request header (ADR 0022).
 */
export async function presignPut(
  configuration: AzureBlobConfiguration,
  key: string,
  options: AzureBlobPresignPutOptions,
): Promise<PresignedPut> {
  const operation = "presignPut";

  requireKey(configuration.container, key, "writable", operation);

  const given = readGroup(configuration.container, options, presignPutOptionKeys, operation);

  const expiresIn = readExpiresIn(configuration.container, given.expiresIn, operation);
  const contentType = readText(
    configuration.container,
    given.contentType,
    "contentType",
    operation,
  );
  const contentLength = readContentLength(configuration.container, given.contentLength, operation);

  const credentials = await resolve(configuration, operation, key);

  // ADR 0022: the key may be right, and it is the wrong form of credential for what was
  // asked, as `KeyBasedAuthenticationNotPermitted` is under ADR 0021.
  if ("accountKey" in credentials) {
    throw azureBlobError(configuration.container, {
      code: "InvalidCredentials",
      message:
        "The credential `accountKey` signs a service SAS, which binds neither content type nor length: `presignPut` needs an `accessToken`",
      operation,
      key,
      attempts: 0,
    });
  }

  const sent = { "content-type": contentType, "x-ms-blob-type": blockBlob };
  const sas = await signUnderDelegation(
    configuration,
    {
      key,
      permissions: "w",
      ...window(expiresIn),
      signedHeaders: [
        ["content-type", contentType],
        ["content-length", contentLength],
        ["x-ms-blob-type", blockBlob],
      ],
    },
    operation,
  );

  return { url: blobUrl(configuration, key, sas.query), headers: sent };
}

/** One user delegation key for this one SAS, valid for as long as the SAS is (ADR 0022). */
async function signUnderDelegation(
  configuration: AzureBlobConfiguration,
  grant: UserDelegationSasGrant,
  operation: string,
): Promise<SignedSas> {
  const delegationKey = await requestUserDelegationKey(
    configuration,
    { start: sasTime(grant.start), expiry: sasTime(grant.expiry) },
    operation,
    grant.key,
  );

  return await signUserDelegationSas(configuration, grant, delegationKey);
}

/** The credential of the call, which decides the kind of SAS (spec 8.9). */
async function resolve(
  configuration: AzureBlobConfiguration,
  operation: string,
  key: string,
): Promise<AzureBlobCredentials> {
  return await resolveCredentials(configuration.credentials, { forceRefresh: false }).catch(
    (failure: unknown) => {
      throw inStorage(failure, configuration.container, operation, key);
    },
  );
}

/** Spec 8.9: from 15 minutes in the past to `expiresIn` seconds from now. */
function window(expiresIn: number): Pick<SasGrant, "start" | "expiry"> {
  const now = Date.now();

  return { start: new Date(now - sasLead), expiry: new Date(now + expiresIn * 1000) };
}

/**
 * The options as a group whose keys are all known. A caller outside TypeScript may hand
 * no group at all, which reads as one holding nothing, so the required `expiresIn` is
 * what the refusal names.
 */
function readGroup(
  container: string,
  options: object,
  known: readonly string[],
  operation: string,
): Readonly<Record<string, unknown>> {
  if (typeof options !== "object" || options === null) return {};

  requireKnownOptions(container, options, known, operation);

  return { ...options };
}

function readExpiresIn(container: string, value: unknown, operation: string): number {
  const inRange = typeof value === "number" && value >= 1 && value <= longestLifetime;

  if (inRange && Number.isInteger(value)) return value;

  throw optionError(
    container,
    "expiresIn",
    `takes the whole seconds 1 to ${longestLifetime}, the seven days a user delegation key lives`,
    operation,
  );
}

// Written out as digits, because `String` writes an integer from `1e21` up as an exponent.
function readContentLength(container: string, value: unknown, operation: string): string {
  if (typeof value === "number" && Number.isInteger(value) && value >= 0) {
    return BigInt(value).toString();
  }

  throw optionError(container, "contentLength", "takes a finite, non-negative integer", operation);
}

function readText(container: string, value: unknown, option: string, operation: string): string {
  if (typeof value === "string" && value !== "") return value;

  throw optionError(container, option, "takes a non-empty string", operation);
}
