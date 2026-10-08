import type { Refusal } from "./errors.ts";
import type { ByteRange } from "./storage.ts";

const invalidBounds: Refusal = {
  code: "InvalidOption",
  message: "The option `range` takes two whole numbers from zero up, `start` at most `end`",
};

/** Refuses bounds spec 4.3 does not allow, which is decided before the object is looked up. */
export function rangeBoundsRefusal(range: ByteRange | undefined): Refusal | undefined {
  if (range === undefined) return undefined;

  const { start, end } = range;

  if (!isOffset(start) || (end !== undefined && (!isOffset(end) || end < start))) {
    return invalidBounds;
  }

  return undefined;
}

/**
 * Refuses a range that starts at or beyond the object's `size` bytes, which spec 4.3 names a
 * refusal of the request rather than of the option, because a provider answers it with `416`.
 */
export function rangeStartRefusal(
  range: ByteRange,
  size: number,
  key: string,
): Refusal | undefined {
  if (range.start < size) return undefined;

  return {
    code: "InvalidRequest",
    message: `The range starts beyond the ${size} bytes under the key ${JSON.stringify(key)}`,
  };
}

/** The last byte the range names, both ends inclusive, clipped to the object's `size` bytes. */
export function lastByteOf(range: ByteRange | undefined, size: number): number {
  return Math.min(range?.end ?? size - 1, size - 1);
}

/**
 * Whether the whole object is the body the range asks for, clipped as spec 4.3 clips it. A
 * provider may answer a range with the whole object and `200`, which RFC 9110 allows, and
 * that answer is the one asked for exactly where this holds. An empty object holds no byte a
 * range could start at, so no range covers it.
 */
export function rangeCoversWhole(range: ByteRange, size: number): boolean {
  return range.start === 0 && size > 0 && lastByteOf(range, size) === size - 1;
}

/** The `Range` field of RFC 9110, both ends inclusive as `ByteRange` is. */
export function rangeHeader(range: ByteRange): string {
  return `bytes=${range.start}-${range.end ?? ""}`;
}

const contentRangePattern = /^bytes (\d+)-(\d+)\/(\d+)$/u;

/**
 * The size of the whole object out of a `206`'s `Content-Range`, which is what spec 4.4 has a
 * ranged `get` report rather than the length of the range.
 */
export function wholeSizeOf(contentRange: string | null): number | undefined {
  const found = contentRangePattern.exec(contentRange?.trim() ?? "");
  const size = Number(found?.[3]);

  return Number.isSafeInteger(size) ? size : undefined;
}

/**
 * `ProviderError` where the value names a content coding other than `identity`. Spec 4.3 refuses
 * every range on such an object: its `size` counts the stored bytes, while a provider may decode
 * them on the way, so no range of what arrives is the range of what is stored (ADR 0044).
 */
export function contentCodingRefusal(
  contentEncoding: string | null | undefined,
  key: string,
): { readonly code: "ProviderError"; readonly message: string } | undefined {
  const coding = contentEncodingOf(contentEncoding);

  if (coding === undefined) return undefined;

  return {
    code: "ProviderError",
    message: `The object under ${JSON.stringify(key)} is stored with the content coding ${JSON.stringify(coding)}, so no range of it can be read`,
  };
}

/**
 * What `contentEncoding` of `ObjectStat` reports for a stored value: the value as stored, or
 * `undefined` where it names no coding. `identity` names none in any case, as RFC 9110 makes
 * the tokens case-insensitive, so the member is set exactly where `contentCodingRefusal`
 * refuses a range (spec 4.4, ADR 0061).
 */
export function contentEncodingOf(contentEncoding: string | null | undefined): string | undefined {
  const coding = contentEncoding ?? "";

  return coding === "" || coding.toLowerCase() === "identity" ? undefined : coding;
}

function isOffset(value: number): boolean {
  return Number.isInteger(value) && value >= 0;
}
