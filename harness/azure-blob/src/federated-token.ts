import type { ResolverOptions } from "../../../packages/core/src/index.ts";

/**
 * A managed identity whose federated credential trusts the job's OIDC token (ADR 0023),
 * and what the Actions runtime hands a job holding `id-token: write` to ask for one.
 */
export interface FederatedIdentity {
  readonly tenantId: string;
  readonly clientId: string;
  /** `ACTIONS_ID_TOKEN_REQUEST_URL`, which carries a query of its own. */
  readonly idTokenRequestUrl: string;
  /** `ACTIONS_ID_TOKEN_REQUEST_TOKEN`. */
  readonly idTokenRequestToken: string;
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
  let held: Promise<IssuedToken> | undefined;

  function renew(): Promise<IssuedToken> {
    const issuing = issue(identity, now);

    held = issuing;
    // A refused exchange is not kept, so that the next request asks again.
    issuing.catch(() => {
      if (held === issuing) held = undefined;
    });

    return issuing;
  }

  // Every call that found `stale` held meets it past its renewal time; only the first of them
  // may renew it, or a burst of requests would each exchange a token of its own.
  function renewedFrom(stale: Promise<IssuedToken>): Promise<IssuedToken> {
    return held === stale || held === undefined ? renew() : held;
  }

  return async (options) => {
    const current = held;

    if (current === undefined || options?.forceRefresh === true) return answered(await renew());

    const token = await current;

    if (now() < token.renewAt) return answered(token);

    return answered(await renewedFrom(current));
  };
}

interface IssuedToken {
  readonly accessToken: string;
  /** Shortly before the expiry Entra answered, so that no request goes out on its last second. */
  readonly renewAt: number;
}

/** Entra issues a token for 60 to 90 minutes. */
const renewalMargin = 5 * 60_000;

function answered(token: IssuedToken): { accessToken: string } {
  return { accessToken: token.accessToken };
}

async function issue(identity: FederatedIdentity, now: () => number): Promise<IssuedToken> {
  const requestedAt = now();
  const { accessToken, expiresIn } = await exchange(identity, await oidcToken(identity));

  return { accessToken, renewAt: requestedAt + expiresIn * 1000 - renewalMargin };
}

async function oidcToken(identity: FederatedIdentity): Promise<string> {
  const url = new URL(identity.idTokenRequestUrl);

  url.searchParams.set("audience", exchangeAudience);

  const response = await fetch(url.href, {
    headers: { authorization: `Bearer ${identity.idTokenRequestToken}` },
  });

  if (!response.ok) {
    await response.body?.cancel();

    throw new Error(
      `The Actions runtime answered ${response.status} to the request for an OIDC token; the job needs \`id-token: write\``,
    );
  }

  const answer: { readonly value: string } = await response.json();

  return answer.value;
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
