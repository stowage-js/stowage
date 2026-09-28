import { type ByteRange, lastByteOf, rangeBoundsRefusal, rangeStartRefusal } from "@stowage/core";

import { fsError } from "./storage-error.ts";

/** Refuses bounds the spec does not allow, before the file is opened (spec 4.3). */
export function requireRange(root: string, range: ByteRange | undefined): void {
  const refusal = rangeBoundsRefusal(range);

  if (refusal !== undefined) throw fsError(root, { ...refusal, operation: "get", attempts: 0 });
}

/** The last byte the range names, both ends inclusive, clipped to what the file holds. */
export function lastByteToRead(
  root: string,
  range: ByteRange | undefined,
  size: number,
  key: string,
): number {
  if (range === undefined) return size - 1;

  // A provider answers `416` for a range that starts past the object, so the refusal
  // belongs to the request rather than to the option (spec 4.3), and it costs the lookup
  // that found the file, as a `NotFound` costs the one that did not.
  const refusal = rangeStartRefusal(range, size, key);

  if (refusal !== undefined) {
    throw fsError(root, { ...refusal, operation: "get", key, attempts: 1 });
  }

  return lastByteOf(range, size);
}
