import type { AzureBlobConfiguration } from "./configuration.ts";
import { serviceVersion } from "./request.ts";
import { hmacSha256Base64, type QueryParameter } from "./sign.ts";

/** What a service SAS grants on one blob: its permissions, from `start` until `expiry`. */
export interface ServiceSasGrant {
  readonly key: string;
  /** In the order Azure requires of a blob, `racwd`. */
  readonly permissions: string;
  readonly start: Date;
  readonly expiry: Date;
}

export interface SignedSas {
  /** The query parameters that authorize a request to the blob, `sig` last. */
  readonly query: readonly QueryParameter[];
  /** Nothing sends it; a fixture that fails on it says which line went wrong. */
  readonly stringToSign: string;
}

/**
 * A service SAS for one blob, signed with the account key (ADR 0022, ADR 0025). It carries
 * no `sip`, no stored policy and no response override, and `spr` admits `http` only where
 * the endpoint is a loopback address, which is Azurite.
 */
export async function signServiceSas(
  configuration: AzureBlobConfiguration,
  grant: ServiceSasGrant,
  accountKey: string,
): Promise<SignedSas> {
  const protocols = configuration.loopback ? "https,http" : "https";
  const start = sasTime(grant.start);
  const expiry = sasTime(grant.expiry);
  // The string to sign of `2020-12-06` and later: the resource is named by account,
  // container and key as they stand, whatever path the endpoint puts in front of them.
  const signed = [
    grant.permissions,
    start,
    expiry,
    `/blob/${configuration.account}/${configuration.container}/${grant.key}`,
    "", // signedIdentifier
    "", // signedIP
    protocols,
    serviceVersion,
    "b", // signedResource
    "", // signedSnapshotTime
    "", // signedEncryptionScope
    "", // rscc
    "", // rscd
    "", // rsce
    "", // rscl
    "", // rsct
  ].join("\n");

  return {
    query: [
      ["sv", serviceVersion],
      ["spr", protocols],
      ["st", start],
      ["se", expiry],
      ["sr", "b"],
      ["sp", grant.permissions],
      ["sig", await hmacSha256Base64(accountKey, signed)],
    ],
    stringToSign: signed,
  };
}

/** ISO 8601 in UTC to the second, one of the forms a SAS accepts. */
function sasTime(time: Date): string {
  return time.toISOString().replace(/\.\d{3}Z$/u, "Z");
}
