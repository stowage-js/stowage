import {
  type ByteRange,
  isStorageError,
  rangeBoundsRefusal,
  rangeCoversWhole,
  rangeStartRefusal,
  type StorageError,
} from "@stowage/core";

import { requestIdHeader } from "./request.ts";
import { gcsError } from "./storage-error.ts";

/** What the provider answers a range it honored with. */
export const partialContent = 206;

const rangeNotSatisfiable = 416;

/** Refuses bounds the spec does not allow, before any request goes out (spec 4.3). */
export function requireRange(bucket: string, range: ByteRange | undefined): void {
  const refusal = rangeBoundsRefusal(range);

  if (refusal !== undefined) throw gcsError(bucket, { ...refusal, operation: "get", attempts: 0 });
}

/** Whether the media download refused the range, which only the resource's size explains. */
export function isUnsatisfiedRange(
  range: ByteRange | undefined,
  failure: unknown,
): failure is StorageError {
  return range !== undefined && isStorageError(failure) && failure.status === rangeNotSatisfiable;
}

/**
 * The download's failure as `get` reports it. Spec 9.8: the media download carries no
 * provider code, so its `416` is reported as the refusal spec 4.3 names for the size the
 * resource named. Where that size leaves room for the range, the object changed between the
 * two requests, and the media failure's message explains the `InvalidRequest`.
 */
export function reportedDownloadFailure(
  bucket: string,
  key: string,
  range: ByteRange | undefined,
  size: number,
  failure: unknown,
): unknown {
  if (range === undefined || !isUnsatisfiedRange(range, failure)) return failure;

  const refusal = rangeStartRefusal(range, size, key);
  const reported = refusal ?? { code: "InvalidRequest" as const, message: failure.message };

  return gcsError(bucket, {
    ...reported,
    operation: "get",
    key,
    attempts: failure.attempts,
    status: failure.status,
    requestId: failure.requestId,
    cause: failure,
  });
}

/**
 * A provider that answers a range with `200` sent the whole object instead, which RFC 9110
 * allows. Where the range covers the object, that is the body asked for. For an object the
 * range starts beyond it is the refusal spec 4.3 names; for any other it is a body the caller
 * did not ask for.
 */
export function wholeAnswerFailure(
  bucket: string,
  key: string,
  range: ByteRange,
  size: number,
  response: Response,
): StorageError | undefined {
  if (rangeCoversWhole(range, size)) return undefined;

  const answered = {
    operation: "get",
    key,
    attempts: 1,
    status: response.status,
    requestId: response.headers.get(requestIdHeader) ?? undefined,
  };
  const refusal = rangeStartRefusal(range, size, key);

  if (refusal !== undefined) return gcsError(bucket, { ...refusal, ...answered });

  return gcsError(bucket, {
    code: "ProviderError",
    message: `The provider answered a range of the object under ${JSON.stringify(key)} with the whole of it`,
    ...answered,
  });
}
