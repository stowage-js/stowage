import {
  type ByteRange,
  isStorageError,
  rangeBoundsRefusal,
  rangeCoversWhole,
  rangeStartRefusal,
  type StorageError,
} from "@stowage/core";

import type { DescribedObject } from "./description.ts";
import { requestIdHeader } from "./request.ts";
import { gcsError } from "./storage-error.ts";

/** What the provider answers a range it honored with. */
const partialContent = 206;

/** Where the media download names the coding of the bytes GCS holds, which it decoded. */
const storedCodingHeader = "x-goog-stored-content-encoding";

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
 * two requests, and the media failure's message explains the `InvalidRequest`. On an object
 * stored with a content coding the size measures the stored bytes, and the range is refused
 * for the coding instead (ADR 0040).
 */
export function reportedDownloadFailure(
  bucket: string,
  key: string,
  range: ByteRange | undefined,
  described: DescribedObject,
  failure: unknown,
): unknown {
  if (range === undefined || !isUnsatisfiedRange(range, failure)) return failure;

  const coding = storedCodingOf(described);
  const reported =
    coding === undefined
      ? (rangeStartRefusal(range, described.stat.size, key) ?? {
          code: "InvalidRequest" as const,
          message: failure.message,
        })
      : codedRangeRefusal(key, coding);

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
 * What refuses the download answering a range, where anything does. Spec 9.4: on an object
 * stored with a content coding, neither answer is the stored bytes the range asked for, so
 * every range is refused, whatever the status. Otherwise a provider that answers a range
 * with `200` sent the whole object instead, which RFC 9110 allows. Where the range covers
 * the object, that is the body asked for. For an object the range starts beyond it is the
 * refusal spec 4.3 names; for any other it is a body the caller did not ask for.
 */
export function answeredRangeRefusal(
  bucket: string,
  key: string,
  range: ByteRange | undefined,
  described: DescribedObject,
  response: Response,
): StorageError | undefined {
  if (range === undefined) return undefined;

  const answered = {
    operation: "get",
    key,
    attempts: 1,
    status: response.status,
    requestId: response.headers.get(requestIdHeader) ?? undefined,
  };
  const coding = storedCodingOf(described, response);

  if (coding !== undefined)
    return gcsError(bucket, { ...codedRangeRefusal(key, coding), ...answered });

  const { size } = described.stat;

  if (response.status === partialContent || rangeCoversWhole(range, size)) return undefined;

  const refusal = rangeStartRefusal(range, size, key);

  if (refusal !== undefined) return gcsError(bucket, { ...refusal, ...answered });

  return gcsError(bucket, {
    code: "ProviderError",
    message: `The provider answered a range of the object under ${JSON.stringify(key)} with the whole of it`,
    ...answered,
  });
}

/**
 * The content coding the object is stored with, off its resource or its media download.
 * GCS names `identity` on the download of an object stored without one.
 */
function storedCodingOf(described: DescribedObject, response?: Response): string | undefined {
  const coding = described.contentEncoding ?? response?.headers.get(storedCodingHeader) ?? "";

  return coding === "" || coding.toLowerCase() === "identity" ? undefined : coding;
}

function codedRangeRefusal(
  key: string,
  coding: string,
): { readonly code: "ProviderError"; readonly message: string } {
  return {
    code: "ProviderError",
    message: `The object under ${JSON.stringify(key)} is stored with the content coding ${JSON.stringify(coding)}, so no range of it can be read`,
  };
}
