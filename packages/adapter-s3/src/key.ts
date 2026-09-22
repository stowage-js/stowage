import { invalidKeyReason, type KeyRule, type StorageError } from "@stowage/core";

import { s3Error } from "./storage-error.ts";

/** The error the key violating the rule is reported as, or `undefined` where it holds. */
export function keyError(
  bucket: string,
  key: string,
  rule: KeyRule,
  operation: string,
): StorageError | undefined {
  const reason = invalidKeyReason(key, rule);

  if (reason === undefined) return undefined;

  return s3Error(bucket, {
    code: "InvalidKey",
    message: `The key ${JSON.stringify(key)} ${reason}`,
    operation,
    key,
    attempts: 0,
  });
}

export function requireKey(bucket: string, key: string, rule: KeyRule, operation: string): void {
  const error = keyError(bucket, key, rule, operation);

  if (error !== undefined) throw error;
}
