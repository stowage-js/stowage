import { invalidKeyReason, type KeyRule, type StorageError } from "@stowage/core";

import { gcsError } from "./storage-error.ts";

/** GCS keeps the path below this prefix for ACME HTTP challenges and refuses to store one. */
const acmeChallengePrefix = ".well-known/acme-challenge/";

/** The two noncharacters GCS refuses in a name; the others, `U+FDD0` among them, it stores. */
const refusedNoncharacter = /[￾￿]/u;

/**
 * Spec 9.1: two kinds of writable key GCS refuses to store are refused before any request
 * (ADR 0032). An addressable key and a prefix meet the core rule alone, so that an object
 * another tool wrote stays reachable.
 */
export function requireKey(bucket: string, key: string, rule: KeyRule, operation: string): void {
  const refusal = keyRefusal(bucket, key, rule, operation);

  if (refusal !== undefined) throw refusal;
}

/** The same rule for `delete`, which reports a key it refuses rather than throwing (spec 4.7). */
export function keyRefusal(
  bucket: string,
  key: string,
  rule: KeyRule,
  operation: string,
): StorageError | undefined {
  const reason = invalidKeyReason(key, rule) ?? (rule === "writable" ? gcsReason(key) : undefined);

  if (reason === undefined) return undefined;

  return gcsError(bucket, {
    code: "InvalidKey",
    message: `The key ${JSON.stringify(key)} ${reason}`,
    operation,
    key,
    attempts: 0,
  });
}

function gcsReason(key: string): string | undefined {
  if (key.startsWith(acmeChallengePrefix)) {
    return `starts with \`${acmeChallengePrefix}\`, which Google Cloud Storage keeps for ACME challenges`;
  }

  const noncharacter = refusedNoncharacter.exec(key)?.[0];

  if (noncharacter !== undefined) {
    const code = noncharacter.charCodeAt(0).toString(16).toUpperCase();

    return `holds the noncharacter U+${code}, which Google Cloud Storage refuses`;
  }

  return undefined;
}
