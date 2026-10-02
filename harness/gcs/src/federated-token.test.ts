import { afterEach, expect, test, vi } from "vitest";

import { type WorkloadIdentity, workloadIdentityFederation } from "./federated-token.ts";

interface SentRequest {
  readonly url: string;
  readonly method: string;
  readonly headers: Headers;
  readonly body: string;
}

const provider =
  "projects/123456789012/locations/global/workloadIdentityPools/github-actions/providers/stowage";

const identity: WorkloadIdentity = {
  provider,
  idTokenRequestUrl: "https://pipelines.actions.githubusercontent.com/abc/idtoken?api-version=2.0",
  idTokenRequestToken: "runtime-request-token",
};

const serviceAccount = "stowage-conformance@stowage-conformance.iam.gserviceaccount.com";

const stsEndpoint = "https://sts.googleapis.com/v1/token";
const generateAccessToken = `https://iamcredentials.googleapis.com/v1/projects/-/serviceAccounts/${serviceAccount}:generateAccessToken`;

interface Responders {
  readonly sts?: (request: SentRequest) => Response;
  readonly iam?: (request: SentRequest) => Response;
}

/**
 * The Actions runtime, STS and IAM Credentials, answering one token per request. Every
 * access token IAM Credentials issues expires an hour after `clock` reads when it is asked.
 */
function stubEndpoints(responders: Responders = {}, clock: () => number = Date.now): SentRequest[] {
  const sent: SentRequest[] = [];
  let federated = 0;
  let impersonated = 0;

  vi.stubGlobal("fetch", async (url: string, init: RequestInit = {}): Promise<Response> => {
    const request: SentRequest = {
      url,
      method: init.method ?? "GET",
      headers: new Headers(init.headers),
      body: typeof init.body === "string" ? init.body : "",
    };

    sent.push(request);

    if (url.startsWith(identity.idTokenRequestUrl)) {
      return Response.json({ value: `oidc-token-${sent.length}` });
    }

    if (url === stsEndpoint) {
      if (responders.sts !== undefined) return responders.sts(request);

      federated += 1;

      return Response.json({
        access_token: `federated-token-${federated}`,
        issued_token_type: "urn:ietf:params:oauth:token-type:access_token",
        token_type: "Bearer",
        expires_in: 3599,
      });
    }

    if (responders.iam !== undefined) return responders.iam(request);

    impersonated += 1;

    return Response.json({
      accessToken: `access-token-${impersonated}`,
      expireTime: new Date(clock() + 3_600_000).toISOString(),
    });
  });

  return sent;
}

afterEach(() => {
  vi.unstubAllGlobals();
});

test("asks the Actions runtime for a token whose audience is the provider", async () => {
  const sent = stubEndpoints();

  await workloadIdentityFederation(identity).impersonate(serviceAccount, "devstorage.read_write")();

  const [oidc] = sent;
  const url = new URL(oidc?.url ?? "");

  expect(url.searchParams.get("api-version")).toBe("2.0");
  expect(url.searchParams.get("audience")).toBe(`https://iam.googleapis.com/${provider}`);
  expect(oidc?.headers.get("authorization")).toBe("Bearer runtime-request-token");
});

test("exchanges the OIDC token at STS for a federated token", async () => {
  const sent = stubEndpoints();

  await workloadIdentityFederation(identity).impersonate(serviceAccount, "devstorage.read_write")();

  const exchange = sent[1];

  expect({ url: exchange?.url, method: exchange?.method }).toEqual({
    url: stsEndpoint,
    method: "POST",
  });
  expect(exchange?.headers.get("content-type")).toBe("application/x-www-form-urlencoded");
  expect(Object.fromEntries(new URLSearchParams(exchange?.body))).toEqual({
    grant_type: "urn:ietf:params:oauth:grant-type:token-exchange",
    audience: `//iam.googleapis.com/${provider}`,
    scope: "https://www.googleapis.com/auth/cloud-platform",
    requested_token_type: "urn:ietf:params:oauth:token-type:access_token",
    subject_token_type: "urn:ietf:params:oauth:token-type:jwt",
    subject_token: "oidc-token-1",
  });
});

test("exchanges the federated token for the service account's token with the storage scope", async () => {
  const sent = stubEndpoints();

  const credentials = await workloadIdentityFederation(identity).impersonate(
    serviceAccount,
    "devstorage.read_write",
  )();

  const impersonation = sent[2];

  expect(credentials).toEqual({ accessToken: "access-token-1" });
  expect({ url: impersonation?.url, method: impersonation?.method }).toEqual({
    url: generateAccessToken,
    method: "POST",
  });
  expect(impersonation?.headers.get("authorization")).toBe("Bearer federated-token-1");
  expect(impersonation?.headers.get("content-type")).toBe("application/json");
  expect(JSON.parse(impersonation?.body ?? "")).toEqual({
    scope: ["https://www.googleapis.com/auth/devstorage.read_write"],
  });
});

// ADR 0034: a storage token's scope does not reach `iamcredentials`, so `signBlob` takes a
// token of its own from the same federated token.
test("takes the token for `signBlob` from the same federated token, with the scope `iam`", async () => {
  const sent = stubEndpoints();
  const federation = workloadIdentityFederation(identity);

  await federation.impersonate(serviceAccount, "devstorage.read_write")();
  const signing = await federation.impersonate(serviceAccount, "iam")();

  const impersonation = sent.at(-1);

  expect(signing).toEqual({ accessToken: "access-token-2" });
  expect(sent.map((request) => request.url).filter((url) => url === stsEndpoint)).toHaveLength(1);
  expect(impersonation?.headers.get("authorization")).toBe("Bearer federated-token-1");
  expect(JSON.parse(impersonation?.body ?? "")).toEqual({
    scope: ["https://www.googleapis.com/auth/iam"],
  });
});

test("keeps the access token for the requests that follow", async () => {
  const sent = stubEndpoints();
  const resolve = workloadIdentityFederation(identity).impersonate(
    serviceAccount,
    "devstorage.read_write",
  );

  await resolve();
  const second = await resolve({ forceRefresh: false });

  expect(second).toEqual({ accessToken: "access-token-1" });
  expect(sent).toHaveLength(3);
});

// The federated token is still good when the bucket refuses the service account's token,
// so the refresh asks IAM Credentials alone.
test("fetches a new one on `forceRefresh`, which the requests after it keep", async () => {
  const sent = stubEndpoints();
  const resolve = workloadIdentityFederation(identity).impersonate(
    serviceAccount,
    "devstorage.read_write",
  );

  await resolve();
  const refreshed = await resolve({ forceRefresh: true });
  const after = await resolve({ forceRefresh: false });

  expect(refreshed).toEqual({ accessToken: "access-token-2" });
  expect(after).toEqual({ accessToken: "access-token-2" });
  expect(sent.map((request) => request.url).slice(3)).toEqual([generateAccessToken]);
});

// The suite sends its requests in parallel, and each resolves the credential before it
// goes out.
test("hands one exchange to the calls that arrive while it is under way", async () => {
  const sent = stubEndpoints();
  const resolve = workloadIdentityFederation(identity).impersonate(
    serviceAccount,
    "devstorage.read_write",
  );

  const answers = await Promise.all([resolve(), resolve(), resolve()]);

  expect(answers).toEqual([
    { accessToken: "access-token-1" },
    { accessToken: "access-token-1" },
    { accessToken: "access-token-1" },
  ]);
  expect(sent).toHaveLength(3);
});

test("fetches a new one within five minutes of the expiry IAM Credentials answered", async () => {
  let now = Date.parse("2026-09-29T04:17:00Z");
  const sent = stubEndpoints({}, () => now);
  const resolve = workloadIdentityFederation(identity, () => now).impersonate(
    serviceAccount,
    "devstorage.read_write",
  );
  const minute = 60_000;

  await resolve();
  now += 54 * minute;
  const kept = await resolve();
  now += 2 * minute;
  const renewed = await resolve();

  expect(kept).toEqual({ accessToken: "access-token-1" });
  expect(renewed).toEqual({ accessToken: "access-token-2" });
  expect(sent).toHaveLength(6);
});

// An attribute condition that does not admit the job answers `400` with this description,
// which is what the run's log has to show.
test("rejects with STS's description of a refused exchange, and asks again after it", async () => {
  let refusing = true;
  const sent = stubEndpoints({
    sts: () =>
      refusing
        ? Response.json(
            {
              error: "unauthorized_client",
              error_description: "The given credential is rejected by the attribute condition.",
            },
            { status: 400 },
          )
        : Response.json({ access_token: "federated-token-after-refusal", expires_in: 3599 }),
  });
  const resolve = workloadIdentityFederation(identity).impersonate(
    serviceAccount,
    "devstorage.read_write",
  );

  await expect(resolve()).rejects.toThrow(
    `STS answered 400 to the token exchange for ${provider}: The given credential is rejected by the attribute condition.`,
  );

  refusing = false;

  await expect(resolve()).resolves.toEqual({ accessToken: "access-token-1" });
  expect(sent.at(-1)?.headers.get("authorization")).toBe("Bearer federated-token-after-refusal");
});

// A principal set without `roles/iam.workloadIdentityUser` on the service account answers so.
test("rejects with IAM Credentials' message where the service account may not be impersonated", async () => {
  stubEndpoints({
    iam: () =>
      Response.json(
        {
          error: {
            code: 403,
            message:
              "Permission 'iam.serviceAccounts.getAccessToken' denied on resource (or it may not exist).",
            status: "PERMISSION_DENIED",
          },
        },
        { status: 403 },
      ),
  });

  await expect(
    workloadIdentityFederation(identity).impersonate(serviceAccount, "iam")(),
  ).rejects.toThrow(
    `IAM Credentials answered 403 to the token for ${serviceAccount} with the scope \`iam\`: Permission 'iam.serviceAccounts.getAccessToken' denied on resource (or it may not exist).`,
  );
});

test("rejects where the Actions runtime hands out no OIDC token", async () => {
  vi.stubGlobal("fetch", async () => new Response("Forbidden", { status: 403 }));

  await expect(
    workloadIdentityFederation(identity).impersonate(serviceAccount, "devstorage.read_write")(),
  ).rejects.toThrow(
    "The Actions runtime answered 403 to the request for an OIDC token; the job needs `id-token: write`",
  );
});

// Spec 18 and ADR 0034: the probe of an expired token asks for one that expires soon, and
// asks with it once it has.
test("issues a token of the service account for a lifetime, kept by no resolver", async () => {
  const sent = stubEndpoints();
  const federation = workloadIdentityFederation(identity);

  const expiring = await federation.expiring(serviceAccount, "devstorage.read_write", 60);
  const held = await federation.impersonate(serviceAccount, "devstorage.read_write")();

  const impersonation = sent[2];

  expect(expiring).toEqual({
    accessToken: "access-token-1",
    expiresAt: expect.any(Number),
  });
  expect(held).toEqual({ accessToken: "access-token-2" });
  expect(JSON.parse(impersonation?.body ?? "")).toEqual({
    scope: ["https://www.googleapis.com/auth/devstorage.read_write"],
    lifetime: "60s",
  });
  expect(sent.map((request) => request.url).filter((url) => url === stsEndpoint)).toHaveLength(1);
});

test("reads the expiry of a token for a lifetime off what IAM Credentials answered", async () => {
  const expireTime = "2026-09-30T04:18:00Z";

  stubEndpoints({ iam: () => Response.json({ accessToken: "short-lived", expireTime }) });

  await expect(
    workloadIdentityFederation(identity).expiring(serviceAccount, "devstorage.read_write", 60),
  ).resolves.toEqual({ accessToken: "short-lived", expiresAt: Date.parse(expireTime) });
});

// Whether `generateAccessToken` grants a lifetime this short is unverified (ADR 0034), and
// the probe records the refusal where it does not.
test("rejects with IAM Credentials' message where it refuses the lifetime", async () => {
  stubEndpoints({
    iam: () =>
      Response.json(
        { error: { code: 400, message: "Invalid lifetime.", status: "INVALID_ARGUMENT" } },
        { status: 400 },
      ),
  });

  await expect(
    workloadIdentityFederation(identity).expiring(serviceAccount, "devstorage.read_write", 60),
  ).rejects.toThrow(
    `IAM Credentials answered 400 to the token for ${serviceAccount} with the scope \`devstorage.read_write\`: Invalid lifetime.`,
  );
});
