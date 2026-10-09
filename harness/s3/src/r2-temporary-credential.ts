import type { S3Credentials } from "../../../packages/adapter-s3/src/index.ts";
import type { ExpiredCredentials } from "./configuration.ts";

/** How long before the signing the credential expired, and how long before that it was issued. */
const expiredFor = 300;
const livedFor = 300;

/**
 * ADR 0067: an R2 temporary credential the harness signs itself, already expired, from the
 * key pair the run is configured with. R2 accepts a JWT signed with the parent's secret
 * (ADR 0045), so no Cloudflare API token is involved and nothing waits for the expiry. Web Crypto rather than `node:crypto`, since `workerd` runs the same target.
 */
export async function expiredR2Credentials(
  parent: S3Credentials,
  endpoint: string,
  bucket: string,
  now: Date,
): Promise<ExpiredCredentials> {
  const host = new URL(endpoint).host;
  const [accountId = ""] = host.split(".");
  const expiry = Math.floor(now.getTime() / 1000) - expiredFor;
  const header = base64Url(JSON.stringify({ alg: "HS256", typ: "JWT" }));
  const payload = base64Url(
    JSON.stringify({
      bucket,
      // The scope is never reached: R2 refuses the credential before it reads one.
      scope: "object-read-only",
      sub: accountId,
      iss: parent.accessKeyId,
      aud: host,
      iat: expiry - livedFor,
      exp: expiry,
    }),
  );
  const signingInput = `${header}.${payload}`;
  // Cloudflare's example keys the HMAC with the secret's UTF-8 bytes, not with it hex-decoded.
  const key = await crypto.subtle.importKey(
    "raw",
    encoded(parent.secretAccessKey),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const signature = await crypto.subtle.sign("HMAC", key, encoded(signingInput));
  const jwt = `${signingInput}.${base64Url(new Uint8Array(signature))}`;
  const digest = await crypto.subtle.digest("SHA-256", encoded(jwt));

  return {
    credentials: {
      accessKeyId: parent.accessKeyId,
      secretAccessKey: hex(new Uint8Array(digest)),
      sessionToken: btoa(`jwt/${jwt}`),
    },
    expiresAt: new Date(expiry * 1000),
  };
}

function encoded(text: string): Uint8Array<ArrayBuffer> {
  return new TextEncoder().encode(text);
}

function base64Url(value: string | Uint8Array): string {
  const bytes = typeof value === "string" ? encoded(value) : value;

  return btoa(String.fromCodePoint(...bytes))
    .replaceAll("+", "-")
    .replaceAll("/", "_")
    .replaceAll("=", "");
}

function hex(bytes: Uint8Array): string {
  return [...bytes].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}
