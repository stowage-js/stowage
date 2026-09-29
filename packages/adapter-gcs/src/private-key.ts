import type { Resolvable } from "@stowage/core";

import type { Sign } from "./signed-url.ts";
import { gcsError, inStorage } from "./storage-error.ts";

/** Why a `privateKey` cannot sign, which the refusal names beside the option. */
export interface RefusedKey {
  readonly refused: string;
}

/** `GOOG4-RSA-SHA256` is RSASSA-PKCS1-v1_5 over SHA-256, which Web Crypto binds to the key. */
const rsaSha256 = { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" } as const;

const pemArmor = /^-----BEGIN PRIVATE KEY-----([A-Za-z0-9+/=\s]+)-----END PRIVATE KEY-----$/u;

/** Where a refusal of the key is told: the storage and the call that asked for a URL. */
export interface KeyUse {
  readonly bucket: string;
  readonly operation: string;
  readonly key: string;
}

/**
 * Spec 9.9: the key is resolved before every URL and cached nowhere, as a credential is, and a
 * key that cannot sign `GOOG4-RSA-SHA256` is `InvalidCredentials` naming `privateKey`.
 */
export async function resolvePrivateKey(
  source: Resolvable<string | CryptoKey>,
  use: KeyUse,
): Promise<CryptoKey> {
  let resolved: unknown;

  try {
    resolved = typeof source === "function" ? await source({ forceRefresh: false }) : source;
  } catch (failure) {
    throw inStorage(failure, use.bucket, use.operation, use.key);
  }

  const imported = await importPrivateKey(resolved);

  if (imported instanceof CryptoKey) return imported;

  throw gcsError(use.bucket, {
    code: "InvalidCredentials",
    message: `The signer's \`privateKey\` ${imported.refused}`,
    operation: use.operation,
    key: use.key,
    attempts: 0,
  });
}

/**
 * Spec 9.9: the key as a JSON key file holds it in `private_key`, a PKCS#8 PEM, or a
 * `CryptoKey` a caller imported themselves, which admits a key that cannot be exported.
 */
export async function importPrivateKey(value: unknown): Promise<CryptoKey | RefusedKey> {
  if (value instanceof CryptoKey) return usableKey(value);

  if (typeof value !== "string") return { refused: "is neither a PEM nor a `CryptoKey`" };

  const body = pemArmor.exec(value.trim())?.[1];

  if (body === undefined) {
    return { refused: "is no PKCS#8 PEM, which starts with `-----BEGIN PRIVATE KEY-----`" };
  }

  try {
    return await crypto.subtle.importKey("pkcs8", bytesOfBase64(body), rsaSha256, false, ["sign"]);
  } catch {
    return { refused: "holds no RSA key Web Crypto imports as PKCS#8" };
  }
}

export function signWith(key: CryptoKey): Sign {
  return async (bytes) => new Uint8Array(await crypto.subtle.sign(rsaSha256, key, bytes));
}

function usableKey(key: CryptoKey): CryptoKey | RefusedKey {
  const { algorithm } = key;
  const hash: unknown = "hash" in algorithm ? algorithm.hash : undefined;
  const hashName = typeof hash === "object" && hash !== null ? Reflect.get(hash, "name") : hash;

  // Web Crypto gives a private RSASSA-PKCS1-v1_5 key no usage but `sign`, so its type and
  // algorithm are what is left to check.
  if (key.type !== "private") return { refused: "is a `CryptoKey` that is not private" };

  if (algorithm.name !== rsaSha256.name || hashName !== rsaSha256.hash) {
    return {
      refused: "is a `CryptoKey` for another algorithm than RSASSA-PKCS1-v1_5 with SHA-256",
    };
  }

  return key;
}

export function bytesOfBase64(text: string): Uint8Array<ArrayBuffer> {
  return Uint8Array.from(atob(text.replace(/\s/gu, "")), (character) => character.charCodeAt(0));
}
