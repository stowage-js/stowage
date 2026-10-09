import { createHash, createHmac } from "node:crypto";

import { expect, test } from "vitest";

import { expiredR2Credentials } from "./r2-temporary-credential.ts";

const parent = { accessKeyId: "parent-access-key-id", secretAccessKey: "parent-secret" };
const endpoint = "https://0123456789abcdef.r2.cloudflarestorage.com";
const now = new Date("2026-10-09T12:00:00Z");

function decoded(part: string | undefined): unknown {
  return JSON.parse(Buffer.from(part ?? "", "base64url").toString());
}

async function signedJwt(): Promise<string> {
  const { credentials } = await expiredR2Credentials(parent, endpoint, "stowage-conformance", now);
  const token = Buffer.from(credentials.sessionToken ?? "", "base64").toString();

  expect(token.startsWith("jwt/")).toBe(true);

  return token.slice("jwt/".length);
}

// `docs/research/r2-expired-request.md` on `research/r2-expired-request`, after Cloudflare's
// "Authenticate against R2 with temporary credentials".
test("the session token carries an HS256 JWT the parent's secret signed", async () => {
  const [header, payload, signature] = (await signedJwt()).split(".");

  expect(decoded(header)).toEqual({ alg: "HS256", typ: "JWT" });
  expect(signature).toBe(
    createHmac("sha256", parent.secretAccessKey).update(`${header}.${payload}`).digest("base64url"),
  );
});

test("the JWT names the bucket, the account and the parent, and expired before it was signed", async () => {
  const [, payload] = (await signedJwt()).split(".");
  const seconds = now.getTime() / 1000;

  expect(decoded(payload)).toEqual({
    bucket: "stowage-conformance",
    scope: "object-read-only",
    sub: "0123456789abcdef",
    iss: "parent-access-key-id",
    aud: "0123456789abcdef.r2.cloudflarestorage.com",
    iat: seconds - 600,
    exp: seconds - 300,
  });
});

test("the secret is the SHA-256 of the JWT, and the access key id the parent's", async () => {
  const jwt = await signedJwt();
  const { credentials } = await expiredR2Credentials(parent, endpoint, "stowage-conformance", now);

  expect(credentials.accessKeyId).toBe("parent-access-key-id");
  expect(credentials.secretAccessKey).toBe(createHash("sha256").update(jwt).digest("hex"));
});

test("says when it expired", async () => {
  const { expiresAt } = await expiredR2Credentials(parent, endpoint, "stowage-conformance", now);

  expect(expiresAt).toEqual(new Date("2026-10-09T11:55:00Z"));
});
