import { afterEach, expect, test, vi } from "vitest";

import type {
  AzureBlobAdapterOptions,
  AzureBlobCredentials,
} from "../../../packages/adapter-azure-blob/src/index.ts";
import {
  accessTokenFrom,
  storageOptionsFrom,
  storageWithDeniedCredentials,
} from "./configuration.ts";

const azurite = {
  STOWAGE_AZURE_BLOB_ENDPOINT: "https://127.0.0.1:10000/devstoreaccount1",
  STOWAGE_AZURE_BLOB_ACCOUNT: "devstoreaccount1",
  STOWAGE_AZURE_BLOB_CONTAINER: "stowage-conformance",
};

/** What the job in the environment `azure-blob` reads, the runtime's two variables beside. */
const account = {
  STOWAGE_AZURE_BLOB_ACCOUNT: "stowageconformance",
  STOWAGE_AZURE_BLOB_CONTAINER: "stowage-conformance",
  STOWAGE_AZURE_BLOB_TENANT_ID: "72f988bf-0000-0000-0000-000000000000",
  STOWAGE_AZURE_BLOB_CLIENT_ID: "c0ffee00-0000-0000-0000-000000000000",
  STOWAGE_AZURE_BLOB_DENIED_CLIENT_ID: "dec1ded0-0000-0000-0000-000000000000",
  ACTIONS_ID_TOKEN_REQUEST_URL: "https://pipelines.actions.githubusercontent.com/idtoken?x=1",
  ACTIONS_ID_TOKEN_REQUEST_TOKEN: "runtime-request-token",
};

/** Entra, answering every exchange with a token that names the client it was issued to. */
function stubEntra(): void {
  vi.stubGlobal("fetch", async (url: string, init: RequestInit = {}): Promise<Response> => {
    if (url.startsWith(account.ACTIONS_ID_TOKEN_REQUEST_URL.split("?")[0] ?? "")) {
      return Response.json({ value: "oidc-token" });
    }

    const form = typeof init.body === "string" ? init.body : "";
    const clientId = new URLSearchParams(form).get("client_id");

    return Response.json({ expires_in: 3599, access_token: `token-for-${clientId}` });
  });
}

async function resolved(
  options: AzureBlobAdapterOptions | undefined,
): Promise<AzureBlobCredentials | undefined> {
  const credentials = options?.credentials;

  return typeof credentials === "function" ? await credentials() : credentials;
}

function claimsOf(credentials: AzureBlobCredentials | undefined): Record<string, unknown> {
  const token =
    credentials !== undefined && "accessToken" in credentials ? credentials.accessToken : "";
  const [, claims = ""] = token.split(".");

  return JSON.parse(atob(claims.replaceAll("-", "+").replaceAll("_", "/")));
}

afterEach(() => {
  vi.unstubAllGlobals();
});

test("without a client id the token is one the harness mints for Azurite", async () => {
  const credentials = await resolved(storageOptionsFrom(azurite, accessTokenFrom(azurite)));

  expect(claimsOf(credentials)["aud"]).toBe("https://storage.azure.com");
});

test("with a client id the token is the one Entra exchanged for that identity", async () => {
  stubEntra();

  const credentials = await resolved(storageOptionsFrom(account, accessTokenFrom(account)));

  expect(credentials).toEqual({ accessToken: `token-for-${account.STOWAGE_AZURE_BLOB_CLIENT_ID}` });
});

// A job without `id-token: write` has no such variables, and a token minted for Azurite in
// their place would be refused by the account with nothing to say why.
test("with a client id and no Actions runtime to ask, every request names what is missing", async () => {
  const withoutRuntime = {
    ...account,
    ACTIONS_ID_TOKEN_REQUEST_URL: undefined,
    ACTIONS_ID_TOKEN_REQUEST_TOKEN: "",
  };
  const options = storageOptionsFrom(withoutRuntime, accessTokenFrom(withoutRuntime));

  await expect(resolved(options)).rejects.toThrow(
    "`STOWAGE_AZURE_BLOB_CLIENT_ID` is set, and `ACTIONS_ID_TOKEN_REQUEST_URL`, `ACTIONS_ID_TOKEN_REQUEST_TOKEN` are not",
  );
});

test("the account is addressed without an endpoint, as a caller in the public cloud has it", () => {
  const options = storageOptionsFrom(account, accessTokenFrom(account));

  expect(options).toMatchObject({
    account: "stowageconformance",
    container: "stowage-conformance",
  });
  expect(options !== undefined && "endpoint" in options).toBe(false);
});

test("without an account or a container nothing is configured", () => {
  expect(
    storageOptionsFrom({ ...azurite, STOWAGE_AZURE_BLOB_ACCOUNT: "" }, accessTokenFrom(azurite)),
  ).toBeUndefined();
  expect(
    storageOptionsFrom(
      { ...azurite, STOWAGE_AZURE_BLOB_CONTAINER: undefined },
      accessTokenFrom(azurite),
    ),
  ).toBeUndefined();
});

test("the denied credential is the reader identity's token", async () => {
  stubEntra();

  const configured = storageOptionsFrom(account, accessTokenFrom(account));
  const denied = configured && storageWithDeniedCredentials(configured, account);

  expect(await resolved(denied)).toEqual({
    accessToken: `token-for-${account.STOWAGE_AZURE_BLOB_DENIED_CLIENT_ID}`,
  });
});

// ADR 0023: Azurite checks no role, so no credential of its own is refused the write.
test("without the reader identity no denied credential is supplied", () => {
  const configured = storageOptionsFrom(azurite, accessTokenFrom(azurite));

  expect(configured && storageWithDeniedCredentials(configured, azurite)).toBeUndefined();
});
