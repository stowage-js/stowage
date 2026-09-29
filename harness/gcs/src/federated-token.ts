import type { ResolverOptions } from "../../../packages/core/src/index.ts";
import {
  type ActionsIdTokenRequest,
  actionsIdToken,
  heldToken,
  type IssuedToken,
  renewalMargin,
} from "../../targets/src/federation.ts";

/** The workload identity provider of ADR 0034, and what the Actions runtime hands the job. */
export interface WorkloadIdentity extends ActionsIdTokenRequest {
  /** `projects/<number>/locations/global/workloadIdentityPools/<pool>/providers/<provider>`. */
  readonly provider: string;
}

/**
 * The scopes a token of the service account is asked for, after
 * `https://www.googleapis.com/auth/`: the one the README leads with for the storage, and the
 * one `signBlob` needs (ADR 0034).
 */
export type GcsScope = "devstorage.read_write" | "iam";

export interface WorkloadIdentityFederation {
  /** A resolver of the service account's tokens with `scope`, each kept until shortly before it expires. */
  impersonate(
    serviceAccount: string,
    scope: GcsScope,
  ): (options?: ResolverOptions) => Promise<{ accessToken: string }>;
}

/**
 * ADR 0034: the bucket's token comes from GitHub OIDC with no secret stored. The job's OIDC
 * token is exchanged at STS for a federated token, which every resolver shares, and that at
 * IAM Credentials for a token of the service account.
 */
export function workloadIdentityFederation(
  identity: WorkloadIdentity,
  now: () => number = Date.now,
): WorkloadIdentityFederation {
  const federated = heldToken(() => federatedToken(identity, now), now);

  return {
    impersonate(serviceAccount, scope) {
      return heldToken(async () => {
        const { accessToken } = await federated();

        return await impersonated(serviceAccount, scope, accessToken);
      }, now);
    },
  };
}

/** The scope STS grants the federated token, which impersonating a service account needs. */
const federatedScope = "https://www.googleapis.com/auth/cloud-platform";

async function federatedToken(identity: WorkloadIdentity, now: () => number): Promise<IssuedToken> {
  const requestedAt = now();
  const subjectToken = await actionsIdToken(
    identity,
    `https://iam.googleapis.com/${identity.provider}`,
  );
  const response = await fetch("https://sts.googleapis.com/v1/token", {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "urn:ietf:params:oauth:grant-type:token-exchange",
      audience: `//iam.googleapis.com/${identity.provider}`,
      scope: federatedScope,
      requested_token_type: "urn:ietf:params:oauth:token-type:access_token",
      subject_token_type: "urn:ietf:params:oauth:token-type:jwt",
      subject_token: subjectToken,
    }).toString(),
  });

  if (!response.ok) {
    const refusal: { readonly error_description?: string } = await response
      .json()
      .catch(() => ({}));

    throw new Error(
      `STS answered ${response.status} to the token exchange for ${identity.provider}: ${refusal.error_description ?? "no description"}`,
    );
  }

  const answer: { readonly access_token: string; readonly expires_in: number } =
    await response.json();

  return {
    accessToken: answer.access_token,
    renewAt: requestedAt + answer.expires_in * 1000 - renewalMargin,
  };
}

async function impersonated(
  serviceAccount: string,
  scope: GcsScope,
  federated: string,
): Promise<IssuedToken> {
  const response = await fetch(
    `https://iamcredentials.googleapis.com/v1/projects/-/serviceAccounts/${serviceAccount}:generateAccessToken`,
    {
      method: "POST",
      headers: { authorization: `Bearer ${federated}`, "content-type": "application/json" },
      body: JSON.stringify({ scope: [`https://www.googleapis.com/auth/${scope}`] }),
    },
  );

  if (!response.ok) {
    const refusal: { readonly error?: { readonly message?: string } } = await response
      .json()
      .catch(() => ({}));

    throw new Error(
      `IAM Credentials answered ${response.status} to the token for ${serviceAccount} with the scope \`${scope}\`: ${refusal.error?.message ?? "no message"}`,
    );
  }

  const answer: { readonly accessToken: string; readonly expireTime: string } =
    await response.json();

  return {
    accessToken: answer.accessToken,
    renewAt: Date.parse(answer.expireTime) - renewalMargin,
  };
}
