import { afterEach, expect, test, vi } from "vitest";

import type { GcsAdapterOptions } from "../../../packages/adapter-gcs/src/index.ts";
import type { ResolverOptions } from "../../../packages/core/src/index.ts";
import { endpointNameFrom, gcsEndpointFrom } from "./configuration.ts";

/** What the adapter reads before a request goes out. */
async function resolve(
  credentials: GcsAdapterOptions["credentials"] | undefined,
  options?: ResolverOptions,
): Promise<{ accessToken: string }> {
  if (credentials === undefined) throw new Error("No credential is configured");

  return typeof credentials === "function" ? await credentials(options) : credentials;
}

const printed = {
  STOWAGE_GCS_ENDPOINT_NAME: "fake-gcs-server",
  STOWAGE_GCS_ENDPOINT: "http://127.0.0.1:4443",
  STOWAGE_GCS_BUCKET: "stowage-conformance",
};

const serviceAccount = "stowage-conformance@stowage-conformance.iam.gserviceaccount.com";
const deniedServiceAccount =
  "stowage-conformance-denied@stowage-conformance.iam.gserviceaccount.com";

/** What `conformance-full.yml` hands a job in the environment `gcs` holding `id-token: write`. */
const scheduled = {
  STOWAGE_GCS_ENDPOINT_NAME: "gcs",
  STOWAGE_GCS_BUCKET: "stowage-conformance",
  STOWAGE_GCS_WORKLOAD_IDENTITY_PROVIDER:
    "projects/123456789012/locations/global/workloadIdentityPools/github-actions/providers/stowage",
  STOWAGE_GCS_SERVICE_ACCOUNT: serviceAccount,
  STOWAGE_GCS_DENIED_SERVICE_ACCOUNT: deniedServiceAccount,
  ACTIONS_ID_TOKEN_REQUEST_URL: "https://pipelines.actions.githubusercontent.com/abc/idtoken",
  ACTIONS_ID_TOKEN_REQUEST_TOKEN: "runtime-request-token",
};

/**
 * The Actions runtime, STS and IAM Credentials, where IAM Credentials names the service
 * account, the scope and the lifetime of each token it issues.
 */
function stubFederation(): void {
  vi.stubGlobal("fetch", async (url: string, init: RequestInit = {}): Promise<Response> => {
    if (url.startsWith(scheduled.ACTIONS_ID_TOKEN_REQUEST_URL)) {
      return Response.json({ value: "oidc-token" });
    }

    if (url === "https://sts.googleapis.com/v1/token") {
      return Response.json({ access_token: "federated-token", expires_in: 3599 });
    }

    const account = /serviceAccounts\/(?<account>[^:]+):generateAccessToken$/u.exec(url)?.groups?.[
      "account"
    ];
    const { scope }: { readonly scope: readonly string[] } = JSON.parse(
      typeof init.body === "string" ? init.body : "",
    );

    const { lifetime = "3600s" }: { readonly lifetime?: string } = JSON.parse(
      typeof init.body === "string" ? init.body : "",
    );

    return Response.json({
      accessToken: `${account} ${scope.join(" ")} ${lifetime}`,
      expireTime: new Date(Date.now() + Number.parseInt(lifetime, 10) * 1000).toISOString(),
    });
  });
}

afterEach(() => {
  vi.unstubAllGlobals();
});

test("the emulator is constructed against what `start.sh` printed, under its fixed token", () => {
  expect(gcsEndpointFrom(printed)).toEqual({
    kind: "emulator",
    options: {
      bucket: "stowage-conformance",
      endpoint: "http://127.0.0.1:4443",
      credentials: { accessToken: "fake-gcs-server" },
    },
  });
});

test.each([
  ["no bucket", { ...printed, STOWAGE_GCS_BUCKET: undefined }],
  ["a bucket a `workerd` binding left unset", { ...printed, STOWAGE_GCS_BUCKET: null }],
  ["neither an endpoint nor a service account", { ...printed, STOWAGE_GCS_ENDPOINT: "" }],
])("nothing is configured with %s", (_, variables) => {
  expect(gcsEndpointFrom(variables)).toBeUndefined();
});

// ADR 0034: as a caller in the public cloud addresses it.
test("the real bucket is addressed without an endpoint", () => {
  const endpoint = gcsEndpointFrom(scheduled);

  expect(endpoint?.kind).toBe("bucket");
  expect(endpoint?.options.bucket).toBe("stowage-conformance");
  expect(endpoint?.options).not.toHaveProperty("endpoint");
});

test("the real bucket runs under the service account's token with the storage scope", async () => {
  stubFederation();

  const endpoint = gcsEndpointFrom(scheduled);

  await expect(resolve(endpoint?.options.credentials)).resolves.toEqual({
    accessToken: `${serviceAccount} https://www.googleapis.com/auth/devstorage.read_write 3600s`,
  });
});

test("the real bucket signs through `signBlob` as the service account, under a token with the scope `iam`", async () => {
  stubFederation();

  const endpoint = gcsEndpointFrom(scheduled);

  if (endpoint?.kind !== "bucket") throw new Error("The scheduled job names no real bucket");

  const { signer } = endpoint;

  expect(signer.serviceAccount).toBe(serviceAccount);
  await expect(resolve("credentials" in signer ? signer.credentials : undefined)).resolves.toEqual({
    accessToken: `${serviceAccount} https://www.googleapis.com/auth/iam 3600s`,
  });
});

test("the denied credential is the second service account's token with the storage scope", async () => {
  stubFederation();

  const endpoint = gcsEndpointFrom(scheduled);

  if (endpoint?.kind !== "bucket") throw new Error("The scheduled job names no real bucket");

  await expect(resolve(endpoint.deniedCredentials)).resolves.toEqual({
    accessToken: `${deniedServiceAccount} https://www.googleapis.com/auth/devstorage.read_write 3600s`,
  });
});

// ADR 0034: the real bucket answers the case, so a job without the second service account
// fails it rather than reporting it skipped.
test("a job naming no second service account is told where the denied credential is resolved", async () => {
  const endpoint = gcsEndpointFrom({ ...scheduled, STOWAGE_GCS_DENIED_SERVICE_ACCOUNT: "" });

  if (endpoint?.kind !== "bucket") throw new Error("The scheduled job names no real bucket");

  await expect(resolve(endpoint.deniedCredentials)).rejects.toThrow(
    "`STOWAGE_GCS_SERVICE_ACCOUNT` is set, and `STOWAGE_GCS_DENIED_SERVICE_ACCOUNT` is not",
  );
});

// A job without `id-token: write` gets no request variables, and the bucket would refuse
// every request with nothing to say why.
test("a job naming a service account and lacking the rest is told on every request", async () => {
  const endpoint = gcsEndpointFrom({
    ...scheduled,
    STOWAGE_GCS_WORKLOAD_IDENTITY_PROVIDER: undefined,
    ACTIONS_ID_TOKEN_REQUEST_TOKEN: "",
  });

  await expect(resolve(endpoint?.options.credentials)).rejects.toThrow(
    "`STOWAGE_GCS_SERVICE_ACCOUNT` is set, and `STOWAGE_GCS_WORKLOAD_IDENTITY_PROVIDER`, `ACTIONS_ID_TOKEN_REQUEST_TOKEN` are not",
  );
});

// ADR 0034: one repeat after the `401`, which `forceRefresh` does not rescue.
test("the bad credential is a token Google refuses, on every call", async () => {
  const endpoint = gcsEndpointFrom(scheduled);

  if (endpoint?.kind !== "bucket") throw new Error("The scheduled job names no real bucket");

  const credentials = endpoint.badCredentials;

  await expect(resolve(credentials)).resolves.toEqual({ accessToken: "not-a-google-token" });
  await expect(resolve(credentials, { forceRefresh: true })).resolves.toEqual({
    accessToken: "not-a-google-token",
  });
});

// Spec 14: the probe asks the bucket with a token of the account the suite runs as.
test("the expiring token is the service account's with the storage scope, for the lifetime asked", async () => {
  stubFederation();

  const endpoint = gcsEndpointFrom(scheduled);

  if (endpoint?.kind !== "bucket") throw new Error("The scheduled job names no real bucket");

  await expect(endpoint.expiringToken(60)).resolves.toEqual({
    accessToken: `${serviceAccount} https://www.googleapis.com/auth/devstorage.read_write 60s`,
    expiresAt: expect.any(Number),
  });
});

test("a job lacking the federation's variables is told where the expiring token is asked", async () => {
  const endpoint = gcsEndpointFrom({ ...scheduled, ACTIONS_ID_TOKEN_REQUEST_URL: undefined });

  if (endpoint?.kind !== "bucket") throw new Error("The scheduled job names no real bucket");

  await expect(endpoint.expiringToken(60)).rejects.toThrow(
    "`STOWAGE_GCS_SERVICE_ACCOUNT` is set, and `ACTIONS_ID_TOKEN_REQUEST_URL` is not",
  );
});

test("the endpoint name is what the job or `start.sh` names", () => {
  expect(endpointNameFrom(scheduled)).toBe("gcs");
  expect(endpointNameFrom(printed)).toBe("fake-gcs-server");
  expect(endpointNameFrom({})).toBeUndefined();
});
