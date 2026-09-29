import type { ResolverOptions } from "../../../packages/core/src/index.ts";

export interface IssuedToken {
  readonly accessToken: string;
  /** Shortly before the expiry the issuer answered, so that no request goes out on its last second. */
  readonly renewAt: number;
}

/** Entra issues a token for 60 to 90 minutes, Google's token services for one hour. */
export const renewalMargin: number = 5 * 60_000;

/**
 * A resolver that keeps what `issue` answered until its renewal time and asks again on
 * `forceRefresh`, after ADR 0023 and ADR 0034: the scheduled run exchanges the job's OIDC
 * token once per hour rather than once per request.
 */
export function heldToken(
  issue: () => Promise<IssuedToken>,
  now: () => number,
): (options?: ResolverOptions) => Promise<{ accessToken: string }> {
  let held: Promise<IssuedToken> | undefined;

  function renew(): Promise<IssuedToken> {
    const issuing = issue();

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

function answered(token: IssuedToken): { accessToken: string } {
  return { accessToken: token.accessToken };
}

/** What the Actions runtime hands a job holding `id-token: write` to ask for its OIDC token. */
export interface ActionsIdTokenRequest {
  /** `ACTIONS_ID_TOKEN_REQUEST_URL`, which carries a query of its own. */
  readonly idTokenRequestUrl: string;
  /** `ACTIONS_ID_TOKEN_REQUEST_TOKEN`. */
  readonly idTokenRequestToken: string;
}

/** The job's OIDC token for `audience`, which the provider's token service exchanges. */
export async function actionsIdToken(
  request: ActionsIdTokenRequest,
  audience: string,
): Promise<string> {
  const url = new URL(request.idTokenRequestUrl);

  url.searchParams.set("audience", audience);

  const response = await fetch(url.href, {
    headers: { authorization: `Bearer ${request.idTokenRequestToken}` },
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
