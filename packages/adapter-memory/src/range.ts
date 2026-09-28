import { type ByteRange, lastByteOf, rangeBoundsRefusal, rangeStartRefusal } from "@stowage/core";

import { memoryError } from "./storage-error.ts";

/** Refuses bounds the spec does not allow, before the key is looked up (spec 4.3). */
export function requireRange(range: ByteRange | undefined): void {
  const refusal = rangeBoundsRefusal(range);

  if (refusal !== undefined) throw memoryError({ ...refusal, operation: "get", attempts: 0 });
}

/** The bytes the range names, both ends inclusive, clipped to what the object holds. */
export function sliceRange(
  bytes: Uint8Array<ArrayBuffer>,
  range: ByteRange | undefined,
  key: string,
): Uint8Array<ArrayBuffer> {
  if (range === undefined) return bytes;

  // A provider answers `416` for a range that starts past the object, so the refusal
  // belongs to the request rather than to the option (spec 4.3), and it costs the lookup
  // that found the object, as a `NotFound` costs the one that did not.
  const refusal = rangeStartRefusal(range, bytes.byteLength, key);

  if (refusal !== undefined) {
    throw memoryError({ ...refusal, operation: "get", key, attempts: 1 });
  }

  return bytes.subarray(range.start, lastByteOf(range, bytes.byteLength) + 1);
}
