import { afterEach, expect, test, vi } from "vitest";

import { type FederatedIdentity, federatedAccessToken } from "./federated-token.ts";

interface SentRequest {
  readonly url: string;
  readonly method: string;
  readonly headers: Headers;
  readonly body: string;
}

const identity: FederatedIdentity = {
  tenantId: "72f988bf-0000-0000-0000-000000000000",
  clientId: "a1b2c3d4-0000-0000-0000-000000000000",
  idTokenRequestUrl: "https://pipelines.actions.githubusercontent.com/abc/idtoken?api-version=2.0",
  idTokenRequestToken: "runtime-request-token",
};

const tokenEndpoint = `https://login.microsoftonline.com/${identity.tenantId}/oauth2/v2.0/token`;

let issued = 0;

/** The Actions runtime and Entra, answering one OIDC token and one access token per request. */
function stubEndpoints(entra?: (request: SentRequest) => Response): SentRequest[] {
  const sent: SentRequest[] = [];

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

    if (entra !== undefined) return entra(request);

    issued += 1;

    return Response.json({
      token_type: "Bearer",
      expires_in: 3599,
      access_token: `access-token-${issued}`,
    });
  });

  return sent;
}

afterEach(() => {
  vi.unstubAllGlobals();
  issued = 0;
});

test("asks the Actions runtime for a token whose audience Entra exchanges", async () => {
  const sent = stubEndpoints();

  await federatedAccessToken(identity)();

  const [oidc] = sent;
  const url = new URL(oidc?.url ?? "");

  expect(url.searchParams.get("api-version")).toBe("2.0");
  expect(url.searchParams.get("audience")).toBe("api://AzureADTokenExchange");
  expect(oidc?.headers.get("authorization")).toBe("Bearer runtime-request-token");
});

test("exchanges the OIDC token at the tenant's endpoint as a `client_assertion`", async () => {
  const sent = stubEndpoints();

  const credentials = await federatedAccessToken(identity)();

  const exchange = sent[1];
  const form = new URLSearchParams(exchange?.body);

  expect(credentials).toEqual({ accessToken: "access-token-1" });
  expect({ url: exchange?.url, method: exchange?.method }).toEqual({
    url: tokenEndpoint,
    method: "POST",
  });
  expect(exchange?.headers.get("content-type")).toBe("application/x-www-form-urlencoded");
  expect(Object.fromEntries(form)).toEqual({
    grant_type: "client_credentials",
    client_id: identity.clientId,
    scope: "https://storage.azure.com/.default",
    client_assertion_type: "urn:ietf:params:oauth:client-assertion-type:jwt-bearer",
    client_assertion: "oidc-token-1",
  });
});

test("keeps the access token for the requests that follow", async () => {
  const sent = stubEndpoints();
  const resolve = federatedAccessToken(identity);

  await resolve();
  const second = await resolve({ forceRefresh: false });

  expect(second).toEqual({ accessToken: "access-token-1" });
  expect(sent).toHaveLength(2);
});

test("fetches a new one on `forceRefresh`, which the requests after it keep", async () => {
  const sent = stubEndpoints();
  const resolve = federatedAccessToken(identity);

  await resolve();
  const refreshed = await resolve({ forceRefresh: true });
  const after = await resolve({ forceRefresh: false });

  expect(refreshed).toEqual({ accessToken: "access-token-2" });
  expect(after).toEqual({ accessToken: "access-token-2" });
  expect(sent).toHaveLength(4);
});

// The suite sends its requests in parallel, and each resolves the credential before it
// goes out.
test("hands one exchange to the calls that arrive while it is under way", async () => {
  const sent = stubEndpoints();
  const resolve = federatedAccessToken(identity);

  const answers = await Promise.all([resolve(), resolve(), resolve()]);

  expect(answers).toEqual([
    { accessToken: "access-token-1" },
    { accessToken: "access-token-1" },
    { accessToken: "access-token-1" },
  ]);
  expect(sent).toHaveLength(2);
});

test("fetches a new one within five minutes of the expiry Entra answered", async () => {
  const sent = stubEndpoints();
  let now = Date.parse("2026-09-26T04:17:00Z");
  const resolve = federatedAccessToken(identity, () => now);
  const minute = 60_000;

  await resolve();
  now += 54 * minute;
  const kept = await resolve();
  now += 2 * minute;
  const renewed = await resolve();

  expect(kept).toEqual({ accessToken: "access-token-1" });
  expect(renewed).toEqual({ accessToken: "access-token-2" });
  expect(sent).toHaveLength(4);
});

// A federated credential whose subject does not match the job answers `400` with
// `AADSTS700213`, which is what the run's log has to show.
test("rejects with Entra's description of a refused exchange, and asks again after it", async () => {
  let refusing = true;
  const sent = stubEndpoints(() =>
    refusing
      ? Response.json(
          {
            error: "invalid_client",
            error_description: "AADSTS700213: No matching federated identity record found.",
          },
          { status: 400 },
        )
      : Response.json({ expires_in: 3599, access_token: "access-token-after-refusal" }),
  );
  const resolve = federatedAccessToken(identity);

  await expect(resolve()).rejects.toThrow(
    "Entra answered 400 to the token exchange for the client a1b2c3d4-0000-0000-0000-000000000000: AADSTS700213: No matching federated identity record found.",
  );

  refusing = false;

  await expect(resolve()).resolves.toEqual({ accessToken: "access-token-after-refusal" });
  expect(sent).toHaveLength(4);
});

test("rejects where the Actions runtime hands out no OIDC token", async () => {
  vi.stubGlobal("fetch", async () => new Response("Forbidden", { status: 403 }));

  await expect(federatedAccessToken(identity)()).rejects.toThrow(
    "The Actions runtime answered 403 to the request for an OIDC token; the job needs `id-token: write`",
  );
});
