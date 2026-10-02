import type { ByteRange } from "@stowage/core";

/** The span a `Range` field names: from a first byte, or the last `suffixLength` bytes. */
export type RequestedRange = ByteRange | { readonly suffixLength: number };

// RFC 9110 14.1 compares a range unit case-insensitively.
const rangePattern = /^bytes=(\d*)-(\d*)$/iu;

/** The one span of the unit `bytes` a `Range` field names, `undefined` where spec 10.3 ignores it. */
export function requestedRangeOf(field: string | null): RequestedRange | undefined {
  const [, first, last] = rangePattern.exec(field ?? "") ?? [];

  if (first === undefined || last === undefined) return undefined;
  if (first === "") return last === "" ? undefined : { suffixLength: positionOf(last) };

  const start = positionOf(first);

  if (last === "") return { start };

  // RFC 9110 14.1.1 makes a last position before the first an invalid range, which spec
  // 10.3 ignores; compared as written, since both may lie beyond a safe integer.
  if (BigInt(last) < BigInt(first)) return undefined;

  return { start, end: positionOf(last) };
}

/**
 * A position as `get` takes it. One beyond a safe integer lies beyond every object, so the
 * largest safe one stands in for it and keeps its meaning.
 */
function positionOf(digits: string): number {
  return Math.min(Number(digits), Number.MAX_SAFE_INTEGER);
}

/** The bytes a suffix of `suffixLength` covers of an object of `size` bytes. */
export function suffixOf(suffixLength: number, size: number): ByteRange {
  return { start: Math.max(0, size - suffixLength), end: size - 1 };
}
