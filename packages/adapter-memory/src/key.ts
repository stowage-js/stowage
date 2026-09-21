import { invalidKeyReason, type KeyRule } from "@stowage/core";

import { memoryError } from "./storage-error.ts";

export function requireKey(key: string, rule: KeyRule, operation: string): void {
  const reason = invalidKeyReason(key, rule);

  if (reason === undefined) return;

  throw memoryError({
    code: "InvalidKey",
    message: `The key ${JSON.stringify(key)} ${reason}`,
    operation,
    key,
    attempts: 0,
  });
}
