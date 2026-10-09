import type { GcsAdapterOptions, GcsSigner } from "../../../packages/adapter-gcs/src/index.ts";
import type { Variables } from "../../s3/src/configuration.ts";
import { unsetVariablesResolver } from "../../targets/src/federation.ts";
import { runOptionsFrom } from "../../targets/src/run-options.ts";
import { staleResolver } from "../../targets/src/stale-credentials.ts";
import { gcsBucket } from "./divergences.ts";
import {
  type ExpiringToken,
  type WorkloadIdentityFederation,
  workloadIdentityFederation,
} from "./federated-token.ts";

type Credentials = GcsAdapterOptions["credentials"];

/**
 * The endpoints of ADR 0034, as the target builds its storages from them: fake-gcs-server,
 * which checks no credential, and the real bucket under the service accounts the job's OIDC
 * token is exchanged for.
 */
export type GcsEndpoint =
  | { readonly kind: "emulator"; readonly options: GcsAdapterOptions }
  | {
      readonly kind: "bucket";
      readonly options: GcsAdapterOptions;
      readonly signer: GcsSigner;
      readonly badCredentials: Credentials;
      readonly deniedCredentials: Credentials;
      /** The credential of spec 14.3's `createStorageWithStaleCredentials`. */
      readonly staleCredentials: (onRefresh: () => void) => Credentials;
      /** A token of the service account `options` runs as, issued for `lifetimeSeconds` alone. */
      readonly expiringToken: (lifetimeSeconds: number) => Promise<ExpiringToken>;
    };

/**
 * ADR 0034: fake-gcs-server checks no credential, so the target resolves one fixed token,
 * which still travels as the bearer every request carries.
 */
const emulatorToken = "fake-gcs-server";

/**
 * ADR 0034: the endpoint is configuration rather than a dependency, so the harness reads a
 * bucket and either the URL `start.sh` prints or the service accounts the job names, and no
 * case knows which server answered. The real bucket is addressed without an endpoint, as a
 * caller in the public cloud addresses it.
 */
export function gcsEndpointFrom(variables: Variables): GcsEndpoint | undefined {
  const endpoint = filled(variables["STOWAGE_GCS_ENDPOINT"]);
  const bucket = filled(variables["STOWAGE_GCS_BUCKET"]);
  const serviceAccount = filled(variables[serviceAccountVariable]);

  if (bucket === undefined) return undefined;

  if (serviceAccount === undefined) {
    if (endpoint === undefined) return undefined;

    return {
      kind: "emulator",
      options: { bucket, endpoint, credentials: { accessToken: emulatorToken } },
    };
  }

  const { impersonate, expiring } = federationFrom(variables);
  const deniedServiceAccount = filled(variables[deniedServiceAccountVariable]);
  const credentials = impersonate(serviceAccount, "devstorage.read_write");

  return {
    kind: "bucket",
    options: { bucket, ...(endpoint === undefined ? {} : { endpoint }), credentials },
    // ADR 0034: a local key there would be a stored secret.
    signer: { serviceAccount, credentials: impersonate(serviceAccount, "iam") },
    badCredentials,
    // Spec 14.3: a credential the bucket accepts and refuses the write to, which is the
    // second service account's, holding `roles/storage.objectViewer` alone. ADR 0034 has the
    // real bucket answer the case, so a job without it fails the case rather than skipping it.
    deniedCredentials:
      deniedServiceAccount === undefined
        ? unsetVariablesResolver(serviceAccountVariable, [deniedServiceAccountVariable])
        : impersonate(deniedServiceAccount, "devstorage.read_write"),
    // ADR 0067: GCS answers a made-up token in the shape of an access token with the `401`
    // that refreshes, as it answers one past its expiry (ADR 0033), so the stale credential
    // needs no token to expire.
    staleCredentials: (onRefresh) => staleResolver(madeUpAccessToken, credentials, onRefresh),
    expiringToken: async (lifetimeSeconds) =>
      await expiring(serviceAccount, "devstorage.read_write", lifetimeSeconds),
  };
}

const serviceAccountVariable = "STOWAGE_GCS_SERVICE_ACCOUNT";
const deniedServiceAccountVariable = "STOWAGE_GCS_DENIED_SERVICE_ACCOUNT";

/**
 * Spec 14.3: a credential the provider refuses. ADR 0034: a resolver that answers a token
 * that is none on every call, `forceRefresh` included, so the case ends after the one repeat.
 */
const badCredentials: Credentials = async () => madeUpAccessToken;

/**
 * ADR 0033: GCS gives `error=invalid_token` only to a token that starts as its access tokens
 * do, `ya29.`, and answers any other string without it, which does not refresh.
 */
const madeUpAccessToken = { accessToken: "ya29.not-a-google-token" };

/** What the job names beside the service accounts, the Actions runtime's two among them. */
const federationVariables = [
  "STOWAGE_GCS_WORKLOAD_IDENTITY_PROVIDER",
  "ACTIONS_ID_TOKEN_REQUEST_URL",
  "ACTIONS_ID_TOKEN_REQUEST_TOKEN",
] as const;

/** A job that names a service account and lacks the rest gets resolvers that say so. */
function federationFrom(variables: Variables): WorkloadIdentityFederation {
  const [provider, idTokenRequestUrl, idTokenRequestToken] = federationVariables.map((name) =>
    filled(variables[name]),
  );

  if (
    provider === undefined ||
    idTokenRequestUrl === undefined ||
    idTokenRequestToken === undefined
  ) {
    const unset = federationVariables.filter((name) => filled(variables[name]) === undefined);
    const refusal = unsetVariablesResolver(serviceAccountVariable, unset);

    return { impersonate: () => refusal, expiring: refusal };
  }

  return workloadIdentityFederation({ provider, idTokenRequestUrl, idTokenRequestToken });
}

/**
 * The scheduled run's job against the real bucket, which alone runs the tests the suite does
 * not assert (spec 14.4) and the probes of spec 18.
 */
export function scheduledAgainstBucket(variables: Variables): boolean {
  return (
    runOptionsFrom(variables).includeSlow === true && endpointNameFrom(variables) === gcsBucket
  );
}

/** Which server answers, for the harness alone: no case reads it (ADR 0012). */
export function endpointNameFrom(variables: Variables): string | undefined {
  return filled(variables["STOWAGE_GCS_ENDPOINT_NAME"]);
}

function filled(value: string | null | undefined): string | undefined {
  return value === undefined || value === null || value === "" ? undefined : value;
}
