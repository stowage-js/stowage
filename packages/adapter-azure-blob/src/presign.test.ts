import { isStorageError, type StorageError } from "@stowage/core";
import { afterEach, beforeEach, expect, test, vi } from "vitest";

import { type AzureBlobAdapterOptions, azureBlobStorage } from "./index.ts";

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"], now: new Date("2026-08-30T12:36:00.500Z") });
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

interface SentRequest {
  readonly url: string;
  readonly method: string;
  readonly headers: Headers;
  readonly body: BodyInit | null | undefined;
}

/** What `fetch` was called with, in order, while it answered `answer`. */
function stubFetch(answer: (request: SentRequest) => Response | Promise<Response>): SentRequest[] {
  const sent: SentRequest[] = [];

  vi.stubGlobal("fetch", async (url: string, init: RequestInit): Promise<Response> => {
    const request: SentRequest = {
      url,
      method: init.method ?? "GET",
      headers: new Headers(init.headers),
      body: init.body,
    };

    sent.push(request);

    return await answer(request);
  });

  return sent;
}

const accessToken = "eyJ0eXAiOiJKV1QifQ.e30.";
const accountKey = "c3Rvd2FnZQ==";

function storage(overrides: Partial<AzureBlobAdapterOptions> = {}) {
  return azureBlobStorage({
    account: "stowage",
    container: "conformance",
    credentials: { accessToken },
    ...overrides,
  });
}

async function failureOf(operation: () => Promise<unknown>): Promise<StorageError> {
  const failure = await operation().then(
    () => undefined,
    (reason: unknown) => reason,
  );

  if (!isStorageError(failure)) throw new Error(`Expected a StorageError, got ${String(failure)}`);

  return failure;
}

/** The query of a URL as name and value pairs, in the order they travel. */
function queryOf(url: string): [string, string][] {
  return [...new URL(url).searchParams];
}

test("under an account key `presignGet` is a service SAS with `sp=r`, and sends nothing", async () => {
  const sent = stubFetch(() => {
    throw new Error("presignGet sends no request under an account key");
  });

  const url = await storage({ credentials: { accountKey } }).presignGet("a b/c.txt", {
    expiresIn: 300,
  });

  expect(sent).toEqual([]);
  expect(url.split("?")[0]).toBe("https://stowage.blob.core.windows.net/conformance/a%20b/c.txt");
  expect(queryOf(url)).toEqual([
    ["sv", "2026-04-06"],
    ["spr", "https"],
    ["st", "2026-08-30T12:21:00Z"],
    ["se", "2026-08-30T12:41:00Z"],
    ["sr", "b"],
    ["sp", "r"],
    ["sig", expect.any(String)],
  ]);
});

test.each([0, 604_801, 1.5, Number.NaN, Number.POSITIVE_INFINITY, "300"])(
  "an `expiresIn` of %s is `InvalidOption` on both methods before anything is sent",
  async (expiresIn) => {
    const sent = stubFetch(() => {
      throw new Error("a refused option sends nothing");
    });
    const presigner = storage();
    // oxlint-disable-next-line no-unsafe-type-assertion -- a caller outside TypeScript
    const lifetime = { expiresIn } as { expiresIn: number };

    for (const failure of [
      await failureOf(async () => await presigner.presignGet("a.txt", lifetime)),
      await failureOf(
        async () =>
          await presigner.presignPut("a.txt", {
            ...lifetime,
            contentType: "text/plain",
            contentLength: 1,
          }),
      ),
    ]) {
      expect(failure).toMatchObject({ code: "InvalidOption", attempts: 0 });
      expect(failure.message).toContain("`expiresIn`");
    }
    expect(sent).toEqual([]);
  },
);

test("an `expiresIn` of 604800 seconds is signed", async () => {
  const url = await storage({ credentials: { accountKey } }).presignGet("a.txt", {
    expiresIn: 604_800,
  });

  expect(queryOf(url)).toContainEqual(["se", "2026-09-06T12:36:00Z"]);
});

test.each([-1, 1.5, Number.NaN, Number.POSITIVE_INFINITY, "11"])(
  "a `contentLength` of %s is `InvalidOption` before anything is sent",
  async (contentLength) => {
    const sent = stubFetch(() => {
      throw new Error("a refused option sends nothing");
    });

    // oxlint-disable-next-line no-unsafe-type-assertion -- a caller outside TypeScript
    const length = { contentLength } as { contentLength: number };
    const failure = await failureOf(
      async () =>
        await storage().presignPut("a.txt", {
          expiresIn: 300,
          contentType: "text/plain",
          ...length,
        }),
    );

    expect(failure).toMatchObject({ code: "InvalidOption", attempts: 0 });
    expect(failure.message).toContain("`contentLength`");
    expect(sent).toEqual([]);
  },
);

test("an unknown option key is `InvalidOption` naming it", async () => {
  // Azure has no override for `Expires`, so the one S3 takes is unknown here.
  const getOptions = { expiresIn: 300, responseExpires: "0" };
  const putOptions = {
    expiresIn: 300,
    contentType: "text/plain",
    contentLength: 1,
    userMetadata: {},
  };
  const get = await failureOf(async () => await storage().presignGet("a.txt", getOptions));
  const put = await failureOf(async () => await storage().presignPut("a.txt", putOptions));

  expect(get).toMatchObject({ code: "InvalidOption", operation: "presignGet" });
  expect(get.message).toContain("`responseExpires`");
  expect(put).toMatchObject({ code: "InvalidOption", operation: "presignPut" });
  expect(put.message).toContain("`userMetadata`");
});

test("an empty response override and an empty content type are `InvalidOption`", async () => {
  const override = await failureOf(
    async () => await storage().presignGet("a.txt", { expiresIn: 300, responseCacheControl: "" }),
  );
  const contentType = await failureOf(
    async () =>
      await storage().presignPut("a.txt", { expiresIn: 300, contentType: "", contentLength: 1 }),
  );

  expect(override.message).toContain("`responseCacheControl`");
  expect(contentType.message).toContain("`contentType`");
});

test("under an account key `presignPut` is `InvalidCredentials` naming `accountKey`, before any request", async () => {
  const sent = stubFetch(() => {
    throw new Error("presignPut sends no request under an account key");
  });

  const failure = await failureOf(
    async () =>
      await storage({ credentials: { accountKey } }).presignPut("a.txt", {
        expiresIn: 300,
        contentType: "text/plain",
        contentLength: 11,
      }),
  );

  expect(failure).toMatchObject({
    code: "InvalidCredentials",
    operation: "presignPut",
    key: "a.txt",
    attempts: 0,
  });
  expect(failure.message).toContain("`accountKey`");
  expect(failure.message).toContain("`presignPut` needs an `accessToken`");
  expect(sent).toEqual([]);
});

function textOf(body: BodyInit | null | undefined): string {
  return body instanceof Uint8Array ? new TextDecoder().decode(body) : "";
}

/** What `Get User Delegation Key` answers: the key, its times echoing the request's. */
function delegationKey(request: SentRequest): Response {
  const body = textOf(request.body);
  const start = /<Start>([^<]*)<\/Start>/u.exec(body)?.[1] ?? "";
  const expiry = /<Expiry>([^<]*)<\/Expiry>/u.exec(body)?.[1] ?? "";

  return new Response(
    `﻿<?xml version="1.0" encoding="utf-8"?><UserDelegationKey><SignedOid>11111111-2222-3333-4444-555555555555</SignedOid><SignedTid>66666666-7777-8888-9999-000000000000</SignedTid><SignedStart>${start}</SignedStart><SignedExpiry>${expiry}</SignedExpiry><SignedService>b</SignedService><SignedVersion>2026-04-06</SignedVersion><Value>c3Rvd2FnZSB1c2VyIGRlbGVnYXRpb24ga2V5IDMyYiE=</Value></UserDelegationKey>`,
    { status: 200, headers: { "content-type": "application/xml" } },
  );
}

test("under an access token `presignPut` requests one user delegation key from `st` to `se`", async () => {
  const sent = stubFetch(delegationKey);

  await storage().presignPut("a.txt", {
    expiresIn: 300,
    contentType: "text/plain",
    contentLength: 11,
  });

  expect(sent).toHaveLength(1);
  expect(sent[0]?.method).toBe("POST");
  expect(sent[0]?.url).toBe(
    "https://stowage.blob.core.windows.net/?restype=service&comp=userdelegationkey",
  );
  expect(sent[0]?.headers.get("authorization")).toBe(`Bearer ${accessToken}`);
  expect(sent[0]?.headers.get("x-ms-version")).toBe("2026-04-06");
  expect(textOf(sent[0]?.body)).toContain(
    "<KeyInfo><Start>2026-08-30T12:21:00Z</Start><Expiry>2026-08-30T12:41:00Z</Expiry></KeyInfo>",
  );
});

test("`presignPut` binds three headers through `srh` and hands back the two a client sends", async () => {
  stubFetch(delegationKey);

  const presigned = await storage().presignPut("a b/c.txt", {
    expiresIn: 300,
    contentType: "text/plain",
    contentLength: 11,
  });

  expect(presigned.headers).toEqual({
    "content-type": "text/plain",
    "x-ms-blob-type": "BlockBlob",
  });
  expect(presigned.url.split("?")[0]).toBe(
    "https://stowage.blob.core.windows.net/conformance/a%20b/c.txt",
  );
  expect(queryOf(presigned.url)).toEqual([
    ["sv", "2026-04-06"],
    ["spr", "https"],
    ["st", "2026-08-30T12:21:00Z"],
    ["se", "2026-08-30T12:41:00Z"],
    ["skoid", "11111111-2222-3333-4444-555555555555"],
    ["sktid", "66666666-7777-8888-9999-000000000000"],
    ["skt", "2026-08-30T12:21:00Z"],
    ["ske", "2026-08-30T12:41:00Z"],
    ["sks", "b"],
    ["skv", "2026-04-06"],
    ["sr", "b"],
    ["sp", "w"],
    ["srh", "content-type,content-length,x-ms-blob-type"],
    ["sig", expect.any(String)],
  ]);
});

const overrides = {
  responseContentType: "text/plain",
  responseContentDisposition: 'attachment; filename="c.txt"',
  responseCacheControl: "no-cache",
};

test("under an access token `presignGet` is a user delegation SAS with `sp=r` and the overrides", async () => {
  const sent = stubFetch(delegationKey);

  const url = await storage().presignGet("a.txt", { expiresIn: 300, ...overrides });
  const query = queryOf(url);

  expect(sent).toHaveLength(1);
  expect(query).toContainEqual(["sp", "r"]);
  expect(query).toContainEqual(["skoid", "11111111-2222-3333-4444-555555555555"]);
  expect(query.map(([name]) => name)).not.toContain("srh");
  expect(query.slice(-4)).toEqual([
    ["rscc", "no-cache"],
    ["rscd", 'attachment; filename="c.txt"'],
    ["rsct", "text/plain"],
    ["sig", expect.any(String)],
  ]);
});

test("under an account key `presignGet` carries the overrides as `rscc`, `rscd` and `rsct`", async () => {
  const url = await storage({ credentials: { accountKey } }).presignGet("a.txt", {
    expiresIn: 300,
    ...overrides,
  });

  expect(queryOf(url).slice(-4)).toEqual([
    ["rscc", "no-cache"],
    ["rscd", 'attachment; filename="c.txt"'],
    ["rsct", "text/plain"],
    ["sig", expect.any(String)],
  ]);
});

function refused(status: number, code: string): Response {
  return new Response(
    `﻿<?xml version="1.0" encoding="utf-8"?><Error><Code>${code}</Code><Message>Refused.</Message></Error>`,
    { status, headers: { "x-ms-error-code": code, "x-ms-request-id": "request-1" } },
  );
}

test("a refused user delegation key is `AccessDenied` naming the key the URL was asked for", async () => {
  stubFetch(() => refused(403, "AuthorizationPermissionMismatch"));

  const failure = await failureOf(
    async () =>
      await storage().presignPut("a.txt", {
        expiresIn: 300,
        contentType: "text/plain",
        contentLength: 11,
      }),
  );

  expect(failure).toMatchObject({
    code: "AccessDenied",
    operation: "presignPut",
    key: "a.txt",
    status: 403,
    providerCode: "AuthorizationPermissionMismatch",
    attempts: 1,
  });
});

test("the key request is repeated as every request is, after a `503` and a refused token", async () => {
  const resolved: boolean[] = [];
  const answers = [refused(503, "ServerBusy"), refused(401, "InvalidAuthenticationInfo")];

  stubFetch((request) => answers.shift() ?? delegationKey(request));

  const url = await storage({
    retry: { maxAttempts: 2 },
    credentials: (options) => {
      resolved.push(options?.forceRefresh ?? false);

      return { accessToken };
    },
  }).presignGet("a.txt", { expiresIn: 300 });

  expect(queryOf(url)).toContainEqual(["sp", "r"]);
  // One to decide the kind of SAS, then the key request's attempts: the `503`, and the
  // refused token with its repeat under `forceRefresh`.
  expect(resolved).toEqual([false, false, false, true]);
});

test("a key answer without a `Value` is `ProviderError`", async () => {
  stubFetch(
    () =>
      new Response("<UserDelegationKey><SignedOid>o</SignedOid></UserDelegationKey>", {
        status: 200,
      }),
  );

  const failure = await failureOf(
    async () => await storage().presignGet("a.txt", { expiresIn: 300 }),
  );

  expect(failure).toMatchObject({ code: "ProviderError", operation: "presignGet" });
});
