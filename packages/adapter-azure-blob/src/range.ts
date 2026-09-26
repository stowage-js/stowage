import type { ByteRange, StorageError } from "@stowage/core";

import { optionError } from "./options.ts";
import { azureBlobError } from "./storage-error.ts";

/** What the provider answers a range it honored with. */
export const partialContent = 206;

const contentRange = /^bytes (\d+)-(\d+)\/(\d+)$/u;

/** Refuses bounds the spec does not allow, before any request goes out (spec 4.3). */
export function requireRange(container: string, range: ByteRange | undefined): void {
  if (range === undefined) return;

  const { start, end } = range;

  if (!isOffset(start) || (end !== undefined && (!isOffset(end) || end < start))) {
    throw optionError(
      container,
      "range",
      "takes two whole numbers from zero up, `start` at most `end`",
      "get",
    );
  }
}

/**
 * The `Range` field of RFC 9110, both ends inclusive as `ByteRange` is. Azure reads it
 * beside its own `x-ms-range`, and Shared Key signs it among its standard headers.
 */
export function rangeHeader(range: ByteRange): string {
  return `bytes=${range.start}-${range.end ?? ""}`;
}

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
 * What an answer to a range means where it is not the range asked for. Azurite answers a
 * start at the size with a `206` for no byte, where Azure answers `416 InvalidRange`; a
 * provider may answer with the whole object and `200`, which RFC 9110 allows and which is
 * the body asked for where the range, clipped as spec 4.3 clips it, covers the object.
 */
export function rangeAnswerFailure(
  container: string,
  key: string,
  range: ByteRange,
  response: Response,
  size: number,
): StorageError | undefined {
  if (response.status === partialContent) {
    return range.start >= size ? startsBeyond(container, key, size) : undefined;
  }

  if (range.start === 0 && size > 0 && (range.end === undefined || range.end >= size - 1)) {
    return undefined;
  }

  if (range.start >= size) return startsBeyond(container, key, size);

  return azureBlobError(container, {
    code: "ProviderError",
    message: `The provider answered a range of the object under ${JSON.stringify(key)} with the whole of it`,
    operation: "get",
    key,
    attempts: 1,
  });
}

function startsBeyond(container: string, key: string, size: number): StorageError {
  return azureBlobError(container, {
    code: "InvalidRequest",
    message: `The range starts beyond the ${size} bytes under the key ${JSON.stringify(key)}`,
    operation: "get",
    key,
    attempts: 1,
  });
}

function isOffset(value: number): boolean {
  return Number.isInteger(value) && value >= 0;
}
