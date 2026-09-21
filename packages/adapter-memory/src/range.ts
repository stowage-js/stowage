import type { ByteRange } from "@stowage/core";

import { memoryError } from "./storage-error.ts";

/** Refuses bounds the spec does not allow, before the key is looked up (spec 4.3). */
export function requireRange(range: ByteRange | undefined): void {
  if (range === undefined) return;

  const { start, end } = range;

  if (!isOffset(start) || (end !== undefined && (!isOffset(end) || end < start))) {
    throw memoryError({
      code: "InvalidOption",
      message: "The option `range` takes two whole numbers from zero up, `start` at most `end`",
      operation: "get",
      attempts: 0,
    });
  }
}

/** The bytes the range names, both ends inclusive, clipped to what the object holds. */
export function sliceRange(
  bytes: Uint8Array<ArrayBuffer>,
  range: ByteRange | undefined,
  key: string,
): Uint8Array<ArrayBuffer> {
  if (range === undefined) return bytes;

  // A provider answers `416` for a range that starts past the object, so the refusal
  // belongs to the request rather than to the option (spec 4.3).
  if (range.start >= bytes.byteLength) {
    throw memoryError({
      code: "InvalidRequest",
      message: `The range starts beyond the ${bytes.byteLength} bytes under the key ${JSON.stringify(key)}`,
      operation: "get",
      key,
      attempts: 1,
    });
  }

  const end = Math.min(range.end ?? bytes.byteLength - 1, bytes.byteLength - 1);

  return bytes.subarray(range.start, end + 1);
}

function isOffset(value: number): boolean {
  return Number.isInteger(value) && value >= 0;
}
