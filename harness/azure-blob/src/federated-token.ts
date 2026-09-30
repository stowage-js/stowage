import type { ResolverOptions } from "../../../packages/core/src/index.ts";
import {
  type ActionsIdTokenRequest,
  actionsIdToken,
  heldToken,
  type IssuedToken,
  renewalMargin,
} from "../../targets/src/federation.ts";

/**
 * A managed identity whose federated credential trusts the job's OIDC token (ADR 0023),
 * and what the Actions runtime hands a job holding `id-token: write` to ask for one.
 */
export interface FederatedIdentity extends ActionsIdTokenRequest {
  readonly tenantId: string;
  readonly clientId: string;
}

/** The audience the federated credentials of the account's identities name. */
const exchangeAudience = "api://AzureADTokenExchange";

const storageScope = "https://storage.azure.com/.default";

/**
 * ADR 0023: the account's token comes from GitHub OIDC with no secret stored. The resolver
 * asks the Actions runtime for an OIDC token and exchanges it at the Entra token endpoint
 * as a `client_assertion`.
 */
export function federatedAccessToken(
  identity: FederatedIdentity,
  now: () => number = Date.now,
): (options?: ResolverOptions) => Promise<{ accessToken: string }> {
  return heldToken(() => issue(identity, now), now);
}

async function issue(identity: FederatedIdentity, now: () => number): Promise<IssuedToken> {
  const requestedAt = now();
  const { accessToken, expiresIn } = await exchange(
    identity,
    await actionsIdToken(identity, exchangeAudience),
  );

  return { accessToken, renewAt: requestedAt + expiresIn * 1000 - renewalMargin };
}

async function exchange(
  identity: FederatedIdentity,
  assertion: string,
): Promise<{ readonly accessToken: string; readonly expiresIn: number }> {
  const response = await fetch(
    `https://login.microsoftonline.com/${identity.tenantId}/oauth2/v2.0/token`,
    {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        grant_type: "client_credentials",
        client_id: identity.clientId,
        scope: storageScope,
        client_assertion_type: "urn:ietf:params:oauth:client-assertion-type:jwt-bearer",
        client_assertion: assertion,
      }).toString(),
    },
  );

  if (!response.ok) {
    const refusal: { readonly error_description?: string } = await response
      .json()
      .catch(() => ({}));

    throw new Error(
      `Entra answered ${response.status} to the token exchange for the client ${identity.clientId}: ${refusal.error_description ?? "no description"}`,
    );
  }

  const answer: { readonly access_token: string; readonly expires_in: number } =
    await response.json();

  return { accessToken: answer.access_token, expiresIn: answer.expires_in };
}
