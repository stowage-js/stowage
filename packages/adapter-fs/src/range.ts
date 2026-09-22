import type { ByteRange } from "@stowage/core";

import { optionError } from "./options.ts";
import { fsError } from "./storage-error.ts";

/** Refuses bounds the spec does not allow, before the file is opened (spec 4.3). */
export function requireRange(root: string, range: ByteRange | undefined): void {
  if (range === undefined) return;

  const { start, end } = range;

  if (!isOffset(start) || (end !== undefined && (!isOffset(end) || end < start))) {
    throw optionError(
      root,
      "range",
      "takes two whole numbers from zero up, `start` at most `end`",
      "get",
    );
  }
}

/** The last byte the range names, both ends inclusive, clipped to what the file holds. */
export function lastByteOf(
  root: string,
  range: ByteRange | undefined,
  size: number,
  key: string,
): number {
  if (range === undefined) return size - 1;

  // A provider answers `416` for a range that starts past the object, so the refusal
  // belongs to the request rather than to the option (spec 4.3), and it costs the lookup
  // that found the file, as a `NotFound` costs the one that did not.
  if (range.start >= size) {
    throw fsError(root, {
      code: "InvalidRequest",
      message: `The range starts beyond the ${size} bytes under the key ${JSON.stringify(key)}`,
      operation: "get",
      key,
      attempts: 1,
    });
  }

  return Math.min(range.end ?? size - 1, size - 1);
}

function isOffset(value: number): boolean {
  return Number.isInteger(value) && value >= 0;
}
