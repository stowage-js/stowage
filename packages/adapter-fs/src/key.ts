import { invalidKeyReason, type KeyRule } from "@stowage/core";

import { fsError } from "./storage-error.ts";

/** What a file system takes as one name, which spec 6 has the adapter refuse beyond. */
const segmentByteLimit = 255;

const utf8 = new TextEncoder();

export function requireKey(root: string, key: string, rule: KeyRule, operation: string): void {
  const reason = invalidKeyReason(key, rule) ?? longSegmentReason(key);

  if (reason === undefined) return;

  throw fsError(root, {
    code: "InvalidKey",
    message: `The key ${JSON.stringify(key)} ${reason}`,
    operation,
    key,
    attempts: 0,
  });
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
