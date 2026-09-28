import { type CapabilityName, checkUserMetadata } from "@stowage/core";

import { memoryError } from "./storage-error.ts";

/**
 * The metadata as it is held: keys folded to lower case, as a header field name is.
 * Rejects before anything is written, in the order of spec 4.3, which reads the refusals
 * off what the storage declares.
 */
export function readUserMetadata(
  userMetadata: Record<string, string> | undefined,
  key: string,
  capabilities: readonly CapabilityName[],
): Readonly<Record<string, string>> {
  const check = checkUserMetadata(userMetadata, capabilities);

  if ("refusal" in check) {
    throw memoryError({ ...check.refusal, operation: "put", key, attempts: 0 });
  }

  return check.held;
}
