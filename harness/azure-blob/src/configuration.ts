import type { AzureBlobAdapterOptions } from "../../../packages/adapter-azure-blob/src/index.ts";
import type { Variables } from "../../s3/src/configuration.ts";
import { runOptionsFrom } from "../../targets/src/run-options.ts";
import { azureBlobAccount } from "./divergences.ts";
import { federatedAccessToken } from "./federated-token.ts";
import { mintAccessToken } from "./token.ts";

type Credentials = AzureBlobAdapterOptions["credentials"];

/**
 * ADR 0023: the endpoint is configuration rather than a dependency, so the harness reads an
 * account, a container and a credential from the environment `start.sh` prints or the job
 * names, and no case knows which server answered. The real account is addressed without an
 * endpoint, as a caller in the public cloud addresses it, and Azurite through the one
 * `start.sh` prints.
 */
export function storageOptionsFrom(
  variables: Variables,
  credentials: Credentials,
): AzureBlobAdapterOptions | undefined {
  const endpoint = filled(variables["STOWAGE_AZURE_BLOB_ENDPOINT"]);
  const account = filled(variables["STOWAGE_AZURE_BLOB_ACCOUNT"]);
  const container = filled(variables["STOWAGE_AZURE_BLOB_CONTAINER"]);

  if (account === undefined || container === undefined) return undefined;

  return { account, container, ...(endpoint === undefined ? {} : { endpoint }), credentials };
}

/**
 * ADR 0023: every conformance case runs under an access token. Where the job names the
 * account's identity, the token is the one Entra exchanges the job's OIDC token for;
 * elsewhere it is one the harness mints for Azurite, fresh for every request.
 */
export function accessTokenFrom(variables: Variables): Credentials {
  return federatedTokenFor(variables, "STOWAGE_AZURE_BLOB_CLIENT_ID") ?? mintedAccessToken;
}

const mintedAccessToken = (): { accessToken: string } => ({ accessToken: mintAccessToken() });

/**
 * Spec 10.3: a credential the provider accepts and refuses the write to. On the account it
 * is the second identity, which holds Storage Blob Data Reader alone (ADR 0023); Azurite
 * checks no role, so where the job names no such identity none is supplied.
 */
export function storageWithDeniedCredentials(
  configured: AzureBlobAdapterOptions,
  variables: Variables,
): AzureBlobAdapterOptions | undefined {
  const credentials = federatedTokenFor(variables, "STOWAGE_AZURE_BLOB_DENIED_CLIENT_ID");

  return credentials === undefined ? undefined : { ...configured, credentials };
}

type ClientIdVariable = "STOWAGE_AZURE_BLOB_CLIENT_ID" | "STOWAGE_AZURE_BLOB_DENIED_CLIENT_ID";

/** What the job names beside the client id, the Actions runtime's two among them. */
const identityVariables = [
  "STOWAGE_AZURE_BLOB_TENANT_ID",
  "ACTIONS_ID_TOKEN_REQUEST_URL",
  "ACTIONS_ID_TOKEN_REQUEST_TOKEN",
] as const;

/**
 * A job that names a client id and lacks the rest, such as one without `id-token: write`,
 * gets a resolver that says so on every request rather than a minted token the account
 * would refuse with nothing to say why.
 */
function federatedTokenFor(
  variables: Variables,
  clientIdVariable: ClientIdVariable,
): Credentials | undefined {
  const clientId = filled(variables[clientIdVariable]);

  if (clientId === undefined) return undefined;

  const [tenantId, idTokenRequestUrl, idTokenRequestToken] = identityVariables.map((name) =>
    filled(variables[name]),
  );

  if (
    tenantId === undefined ||
    idTokenRequestUrl === undefined ||
    idTokenRequestToken === undefined
  ) {
    const missing = identityVariables.filter((name) => filled(variables[name]) === undefined);
    const names = missing.map((name) => `\`${name}\``).join(", ");

    return async () => {
      throw new Error(
        `\`${clientIdVariable}\` is set, and ${names} ${missing.length === 1 ? "is" : "are"} not`,
      );
    };
  }

  return federatedAccessToken({ tenantId, clientId, idTokenRequestUrl, idTokenRequestToken });
}

/**
 * Spec 10.3: a credential the provider refuses. A token that is not a JWT is refused by
 * Azurite and by the service alike, and needs no identity configured for it.
 */
export function storageWithBadCredentials(
  configured: AzureBlobAdapterOptions,
): AzureBlobAdapterOptions {
  return { ...configured, credentials: { accessToken: "not-a-jwt" } };
}

/** Which server answers, for the harness alone: no case reads it (ADR 0012). */
export function endpointNameFrom(variables: Variables): string | undefined {
  return filled(variables["STOWAGE_AZURE_BLOB_ENDPOINT_NAME"]);
}

/** Where the scheduled run asks for the slow tier against the account, which is where spec 14 is asked. */
export function scheduledAgainstAccount(variables: Variables): boolean {
  return (
    runOptionsFrom(variables).includeSlow === true &&
    endpointNameFrom(variables) === azureBlobAccount
  );
}

function filled(value: string | null | undefined): string | undefined {
  return value === undefined || value === null || value === "" ? undefined : value;
}
