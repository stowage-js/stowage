import type { AzureBlobConfiguration } from "./configuration.ts";
import { serviceVersion } from "./request.ts";
import { type HeaderField, hmacSha256Base64, type QueryParameter } from "./sign.ts";

const minute = 60 * 1000;

/** ADR 0022: a SAS starts early enough for a service clock that trails this one. */
export const sasLead: number = 15 * minute;

/** What a SAS grants on one blob: its permissions, from `start` until `expiry`. */
export interface SasGrant {
  readonly key: string;
  /** In the order Azure requires of a blob, `racwd`. */
  readonly permissions: string;
  readonly start: Date;
  readonly expiry: Date;
  readonly overrides?: ResponseOverrides;
}

/** The response headers a `GET` through the SAS is answered with in place of the blob's. */
export interface ResponseOverrides {
  readonly cacheControl?: string;
  readonly contentDisposition?: string;
  readonly contentType?: string;
}

export interface UserDelegationSasGrant extends SasGrant {
  /** The request headers `srh` binds, in the order it names them, with their values. */
  readonly signedHeaders?: readonly HeaderField[];
}

/** A key as `Get User Delegation Key` answered it, its times as the service wrote them. */
export interface UserDelegationKey {
  readonly signedOid: string;
  readonly signedTid: string;
  readonly signedStart: string;
  readonly signedExpiry: string;
  readonly signedService: string;
  readonly signedVersion: string;
  /** Base64, decoded into the HMAC key as an account key is. */
  readonly value: string;
}

export interface SignedSas {
  /** The query parameters that authorize a request to the blob, `sig` last. */
  readonly query: readonly QueryParameter[];
  /** Nothing sends it; a fixture that fails on it says which line went wrong. */
  readonly stringToSign: string;
}

/**
 * A service SAS for one blob, signed with the account key (ADR 0022, ADR 0025). It carries
 * no `sip` and no stored policy, and `spr` admits `http` only where the endpoint is a
 * loopback address, which is Azurite.
 */
export async function signServiceSas(
  configuration: AzureBlobConfiguration,
  grant: SasGrant,
  accountKey: string,
): Promise<SignedSas> {
  const common = commonFields(configuration, grant);
  // The string to sign of `2020-12-06` and later: the resource is named by account,
  // container and key as they stand, whatever path the endpoint puts in front of them.
  const signed = [
    grant.permissions,
    common.start,
    common.expiry,
    common.resource,
    "", // signedIdentifier
    "", // signedIP
    common.protocols,
    serviceVersion,
    "b", // signedResource
    "", // signedSnapshotTime
    "", // signedEncryptionScope
    ...overrideLines(grant.overrides),
  ].join("\n");

  return {
    query: [
      ...common.leadingQuery,
      ["sr", "b"],
      ["sp", grant.permissions],
      ...overrideQuery(grant.overrides),
      ["sig", await hmacSha256Base64(accountKey, signed)],
    ],
    stringToSign: signed,
  };
}

/**
 * A user delegation SAS for one blob, signed with a key `Get User Delegation Key` handed
 * out (ADR 0022). From `sv=2026-04-06` on it binds the request headers `srh` names: the
 * request is refused unless it carries each of them with the value signed here.
 */
export async function signUserDelegationSas(
  configuration: AzureBlobConfiguration,
  grant: UserDelegationSasGrant,
  key: UserDelegationKey,
): Promise<SignedSas> {
  const common = commonFields(configuration, grant);
  const signedHeaders = grant.signedHeaders ?? [];
  const signed = [
    grant.permissions,
    common.start,
    common.expiry,
    common.resource,
    key.signedOid,
    key.signedTid,
    key.signedStart,
    key.signedExpiry,
    key.signedService,
    key.signedVersion,
    "", // signedAuthorizedUserObjectId
    "", // signedUnauthorizedUserObjectId
    "", // signedCorrelationId
    "", // signedKeyDelegatedUserTenantId
    "", // signedDelegatedUserObjectId
    "", // signedIP
    common.protocols,
    serviceVersion,
    "b", // signedResource
    "", // signedSnapshotTime
    "", // signedEncryptionScope
    // Each header ends in a newline of its own, so the field ends in one before the
    // joining newline: what Azure computed on the real account (docs/research).
    signedHeaders.map(([name, value]) => `${name}:${value}\n`).join(""),
    "", // signedRequestQueryParameters
    ...overrideLines(grant.overrides),
  ].join("\n");
  const headerNames = signedHeaders.map(([name]) => name).join(",");

  return {
    query: [
      ...common.leadingQuery,
      ["skoid", key.signedOid],
      ["sktid", key.signedTid],
      ["skt", key.signedStart],
      ["ske", key.signedExpiry],
      ["sks", key.signedService],
      ["skv", key.signedVersion],
      ["sr", "b"],
      ["sp", grant.permissions],
      ...(headerNames === "" ? [] : [["srh", headerNames] as const]),
      ...overrideQuery(grant.overrides),
      ["sig", await hmacSha256Base64(key.value, signed)],
    ],
    stringToSign: signed,
  };
}

function commonFields(configuration: AzureBlobConfiguration, grant: SasGrant) {
  const protocols = configuration.loopback ? "https,http" : "https";
  const start = sasTime(grant.start);
  const expiry = sasTime(grant.expiry);
  const leadingQuery: readonly QueryParameter[] = [
    ["sv", serviceVersion],
    ["spr", protocols],
    ["st", start],
    ["se", expiry],
  ];

  return {
    protocols,
    start,
    expiry,
    resource: `/blob/${configuration.account}/${configuration.container}/${grant.key}`,
    leadingQuery,
  };
}

/** `rscc`, `rscd`, `rsce`, `rscl` and `rsct`, the two stowage never sets empty. */
function overrideLines(overrides: ResponseOverrides | undefined): string[] {
  return [
    overrides?.cacheControl ?? "",
    overrides?.contentDisposition ?? "",
    "", // rsce
    "", // rscl
    overrides?.contentType ?? "",
  ];
}

function overrideQuery(overrides: ResponseOverrides | undefined): QueryParameter[] {
  const query: QueryParameter[] = [];

  if (overrides?.cacheControl !== undefined) query.push(["rscc", overrides.cacheControl]);
  if (overrides?.contentDisposition !== undefined) {
    query.push(["rscd", overrides.contentDisposition]);
  }
  if (overrides?.contentType !== undefined) query.push(["rsct", overrides.contentType]);

  return query;
}

/** ISO 8601 in UTC to the second, one of the forms a SAS accepts. */
export function sasTime(time: Date): string {
  return time.toISOString().replace(/\.\d{3}Z$/u, "Z");
}
