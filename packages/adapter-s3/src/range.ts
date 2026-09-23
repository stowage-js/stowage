import type { ByteRange, StorageError } from "@stowage/core";

import { optionError } from "./options.ts";
import { s3Error } from "./storage-error.ts";

/** Refuses bounds the spec does not allow, before any request goes out (spec 4.3). */
export function requireRange(bucket: string, range: ByteRange | undefined): void {
  if (range === undefined) return;

  const { start, end } = range;

  if (!isOffset(start) || (end !== undefined && (!isOffset(end) || end < start))) {
    throw optionError(
      bucket,
      "range",
      "takes two whole numbers from zero up, `start` at most `end`",
      "get",
    );
  }
}

/** The `Range` field of RFC 9110, both ends inclusive as `ByteRange` is. */
export function rangeHeader(range: ByteRange): string {
  return `bytes=${range.start}-${range.end ?? ""}`;
}

const contentRange = /^bytes (\d+)-(\d+)\/(\d+)$/u;

/**
 * The size of the whole object out of a `206`'s `Content-Range`, which is what spec 4.4
 * has a ranged `get` report rather than the length of the range.
 */
export function wholeSizeOf(response: Response): number | undefined {
  const found = contentRange.exec(response.headers.get("content-range")?.trim() ?? "");
  const size = Number(found?.[3]);

  return Number.isSafeInteger(size) ? size : undefined;
}

/**
 * A provider that answers a ranged `GET` with `200` sent the whole object instead. For an
 * object the range starts beyond, which is how S3 answers a range on an empty object, that
 * is the refusal spec 4.3 names; for any other it is a body the caller did not ask for.
 */
export function wholeObjectFailure(
  bucket: string,
  key: string,
  range: ByteRange,
  size: number,
): StorageError {
  if (range.start >= size) {
    return s3Error(bucket, {
      code: "InvalidRequest",
      message: `The range starts beyond the ${size} bytes under the key ${JSON.stringify(key)}`,
      operation: "get",
      key,
      attempts: 1,
    });
  }

  return s3Error(bucket, {
    code: "ProviderError",
    message: `The provider answered a range of the object under ${JSON.stringify(key)} with the whole of it`,
    operation: "get",
    key,
    attempts: 1,
  });
}

function isOffset(value: number): boolean {
  return Number.isInteger(value) && value >= 0;
}
