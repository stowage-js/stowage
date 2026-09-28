import {
  type ByteRange,
  rangeBoundsRefusal,
  rangeCoversWhole,
  rangeStartRefusal,
  type StorageError,
} from "@stowage/core";

import { s3Error } from "./storage-error.ts";

/** Refuses bounds the spec does not allow, before any request goes out (spec 4.3). */
export function requireRange(bucket: string, range: ByteRange | undefined): void {
  const refusal = rangeBoundsRefusal(range);

  if (refusal !== undefined) throw s3Error(bucket, { ...refusal, operation: "get", attempts: 0 });
}

/** What a provider answers a range it honored with. */
export const partialContent = 206;

/**
 * A provider that answers a ranged `GET` with `200` sent the whole object instead, which
 * RFC 9110 allows. Where the range covers the object, that is the body asked for. For an
 * object the range starts beyond, which is how S3 answers a range on an empty object, it is
 * the refusal spec 4.3 names; for any other it is a body the caller did not ask for.
 */
export function wholeAnswerFailure(
  bucket: string,
  key: string,
  range: ByteRange,
  size: number,
): StorageError | undefined {
  if (rangeCoversWhole(range, size)) return undefined;

  const refusal = rangeStartRefusal(range, size, key);

  if (refusal !== undefined) {
    return s3Error(bucket, { ...refusal, operation: "get", key, attempts: 1 });
  }

  return s3Error(bucket, {
    code: "ProviderError",
    message: `The provider answered a range of the object under ${JSON.stringify(key)} with the whole of it`,
    operation: "get",
    key,
    attempts: 1,
  });
}
