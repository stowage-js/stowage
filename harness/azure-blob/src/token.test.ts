import { expect, test } from "vitest";

import { mintAccessToken } from "./token.ts";

function claimsOf(token: string): Record<string, unknown> {
  const [, claims = ""] = token.split(".");
  const json = atob(claims.replaceAll("-", "+").replaceAll("_", "/"));

  return JSON.parse(json);
}

const now = new Date("2026-09-25T12:00:00Z");
const seconds = now.getTime() / 1000;

test("the token is an unsigned JWT: a header, the claims and an empty signature", () => {
  const [header = "", , signature, ...rest] = mintAccessToken(now).split(".");

  expect(JSON.parse(atob(header))).toEqual({ alg: "none", typ: "JWT" });
  expect(signature).toBe("");
  expect(rest).toEqual([]);
});

test("the token is for Azure Storage, from an issuer Azurite accepts", () => {
  const claims = claimsOf(mintAccessToken(now));

  expect(claims["aud"]).toBe("https://storage.azure.com");
  expect(String(claims["iss"])).toMatch(/^https:\/\/sts\.windows\.net\//u);
});

// Azurite answers `Get User Delegation Key` with an empty `500` for a token without them,
// and hands them back as the key's `SignedOid` and `SignedTid`.
test("the token names a principal and the tenant of its issuer", () => {
  const claims = claimsOf(mintAccessToken(now));

  expect(claims["oid"]).toMatch(/^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/u);
  expect(String(claims["iss"])).toBe(`https://sts.windows.net/${String(claims["tid"])}/`);
});

test("the token holds from a minute ago for an hour", () => {
  const claims = claimsOf(mintAccessToken(now));

  expect(claims["iat"]).toBe(seconds - 60);
  expect(claims["nbf"]).toBe(seconds - 60);
  expect(claims["exp"]).toBe(seconds + 3600);
});

test("no part of the token needs escaping in a header", () => {
  expect(mintAccessToken(now)).toMatch(/^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.$/u);
});
