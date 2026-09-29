import { expect, test } from "vitest";

import serviceAccount from "./fixtures/dummy-service-account.json" with { type: "json" };
import vectors from "./fixtures/v4-signatures.json" with { type: "json" };
import { signUrl } from "./signed-url.ts";
import { importPrivateKey, signWith } from "./signer.ts";

/*
 * Google's V4 signing vectors, 29 signed URLs and 11 POST policies, with the inactive key they
 * are signed with: `storage/v1/v4_signatures.json` and `test_service_account.not-a-test.json` of
 * `googleapis/conformance-tests` at 905d67f4ecd6d0a172d369bbe5b4762f79edca49, under the Apache
 * License 2.0. The vectors are unchanged but for formatting; of the key file only the service
 * account and the key are kept (spec 10.4, ADR 0035).
 */

interface SigningVector {
  readonly description: string;
  readonly bucket: string;
  readonly object?: string;
  readonly method: string;
  readonly expiration: number;
  readonly timestamp: string;
  readonly headers?: Readonly<Record<string, string | undefined>>;
  readonly queryParameters?: Readonly<Record<string, string | undefined>>;
  readonly urlStyle?: string;
  readonly expectedUrl: string;
  readonly expectedStringToSign: string;
}

const signingVectors: readonly SigningVector[] = vectors.signingV4Tests;

/**
 * The vectors whose request the adapter never builds, which reach the signature alone: a
 * virtual-hosted URL or a bucket-bound hostname, which spec 9.9 does not offer, and a signed
 * payload, which a URL the adapter hands out never carries.
 */
function isBuiltByTheAdapter(vector: SigningVector): boolean {
  const headers = Object.keys(vector.headers ?? {}).map((name) => name.toLowerCase());

  return vector.urlStyle === undefined && !headers.includes("x-goog-content-sha256");
}

/**
 * The scheme and authority the expected URL starts with. Which of a hostname, a client
 * endpoint, an emulator host and a universe domain wins is how Google's clients read their
 * configuration; the adapter takes its endpoint as given.
 */
function originOf(url: string): string {
  const origin = /^[a-z]+:\/\/[^/]+/u.exec(url)?.[0];

  if (origin === undefined) throw new Error(`The URL ${url} has no origin`);

  return origin;
}

/** The pairs of a vector's headers or query, which the JSON types with every other vector's names. */
function fieldsOf(
  record: Readonly<Record<string, string | undefined>> | undefined,
): (readonly [string, string])[] {
  return Object.entries(record ?? {}).flatMap(([name, value]) =>
    value === undefined ? [] : [[name, value] as const],
  );
}

function signatureOf(url: string): string | null {
  return new URL(url).searchParams.get("X-Goog-Signature");
}

async function dummySigner() {
  const key = await importPrivateKey(serviceAccount.private_key);

  if (!(key instanceof CryptoKey)) throw new Error(`The dummy key is refused: ${key.refused}`);

  return signWith(key);
}

const hex = (bytes: Uint8Array): string =>
  Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");

test.each(signingVectors.filter(isBuiltByTheAdapter).map((vector) => [vector.description, vector]))(
  "the signed URL of the vector %s is built and signed as Google's",
  async (_, vector) => {
    const url = await signUrl(
      {
        method: vector.method,
        origin: originOf(vector.expectedUrl),
        path:
          vector.object === undefined ? `/${vector.bucket}` : `/${vector.bucket}/${vector.object}`,
        headers: fieldsOf(vector.headers),
        query: fieldsOf(vector.queryParameters),
        serviceAccount: serviceAccount.client_email,
        signedAt: new Date(vector.timestamp),
        expiresIn: vector.expiration,
      },
      await dummySigner(),
    );

    expect(url).toBe(vector.expectedUrl);
  },
);

test.each(signingVectors.map((vector) => [vector.description, vector]))(
  "the local key signs the string to sign of the vector %s as Google's",
  async (_, vector) => {
    const sign = await dummySigner();
    const signature = await sign(new TextEncoder().encode(vector.expectedStringToSign));

    expect(hex(signature)).toBe(signatureOf(vector.expectedUrl));
  },
);

test.each(vectors.postPolicyV4Tests.map((vector) => [vector.description, vector]))(
  "the local key signs the policy of the vector %s as Google's",
  async (_, vector) => {
    const { policy, "x-goog-signature": expected } = vector.policyOutput.fields;
    const sign = await dummySigner();

    expect(hex(await sign(new TextEncoder().encode(policy)))).toBe(expected);
  },
);

test("the adapter builds 24 of the 29 signed URLs, and signs all 40 vectors", () => {
  expect(signingVectors.filter(isBuiltByTheAdapter)).toHaveLength(24);
  expect(signingVectors.length + vectors.postPolicyV4Tests.length).toBe(40);
});
