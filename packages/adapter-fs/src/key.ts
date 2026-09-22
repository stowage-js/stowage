import { invalidKeyReason, type KeyRule } from "@stowage/core";

import { fsError } from "./storage-error.ts";

/** What a file system takes as one name, which spec 6 has the adapter refuse beyond. */
const segmentByteLimit = 255;

/** The name a write in flight holds: a file of this adapter, and no object of anyone. */
export const temporaryName: RegExp = /^\.stowage-[\da-f-]{36}\.tmp$/;

const utf8 = new TextEncoder();

export function requireKey(root: string, key: string, rule: KeyRule, operation: string): void {
  const reason =
    invalidKeyReason(key, rule) ?? temporaryNameReason(key, rule) ?? longSegmentReason(key);

  if (reason === undefined) return;

  throw fsError(root, {
    code: "InvalidKey",
    message: `The key ${JSON.stringify(key)} ${reason}`,
    operation,
    key,
    attempts: 0,
  });
}

function temporaryNameReason(key: string, rule: KeyRule): string | undefined {
  if (rule !== "writable" || !temporaryName.test(key.slice(key.lastIndexOf("/") + 1))) {
    return undefined;
  }

  return "uses the reserved .stowage temporary-file name";
}

// Spec 4.8 lets an adapter refuse more than the rule and report that as `InvalidKey`,
// which is what keeps a key the file system would answer `ENAMETOOLONG` for out of a
// request that has already created directories on its way to it.
function longSegmentReason(key: string): string | undefined {
  for (const segment of key.split("/")) {
    const bytes = utf8.encode(segment).length;

    if (bytes > segmentByteLimit) {
      return `holds a segment of ${bytes} UTF-8 bytes, above the limit of ${segmentByteLimit}`;
    }
  }

  return undefined;
}
