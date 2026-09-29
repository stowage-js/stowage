import { type CapabilityName, checkUserMetadata, decodeUserMetadataValue } from "@stowage/core";

import { fieldOf } from "./json.ts";
import { gcsError } from "./storage-error.ts";

/**
 * The user metadata as `put` sends it, keys folded to lower case, or the refusal of spec 4.3
 * before anything is sent. Values stay as written: the JSON body carries any Unicode, so no
 * value is RFC 2047-encoded (ADR 0032).
 */
export function heldUserMetadata(
  bucket: string,
  userMetadata: Record<string, string> | undefined,
  key: string,
  capabilities: readonly CapabilityName[],
): Readonly<Record<string, string>> {
  const check = checkUserMetadata(userMetadata, capabilities);

  if ("refusal" in check) {
    throw gcsError(bucket, { ...check.refusal, operation: "put", key, attempts: 0 });
  }

  return check.held;
}

/**
 * The resource's `metadata`, keys as stored. Folding them would drop a value where another
 * tool wrote `A` beside `a`. An encoded word is decoded, so an object `adapter-s3` wrote
 * through the XML API reads the same (ADR 0032).
 */
export function readUserMetadata(resource: unknown): Readonly<Record<string, string>> {
  const stored = fieldOf(resource, "metadata");
  const held: Record<string, string> = Object.create(null);

  if (typeof stored === "object" && stored !== null) {
    for (const [name, value] of Object.entries(stored)) {
      if (typeof value === "string") held[name] = decodeUserMetadataValue(value);
    }
  }

  return Object.freeze(held);
}
