import {
  type ByteRange,
  contentCodingRefusal,
  rangeBoundsRefusal,
  rangeCoversWhole,
  rangeStartRefusal,
  type StorageError,
  type StorageErrorFields,
} from "@stowage/core";

import { azureBlobError } from "./storage-error.ts";

/** What the provider answers a range it honored with. */
export const partialContent = 206;

/** Refuses bounds the spec does not allow, before any request goes out (spec 4.3). */
export function requireRange(container: string, range: ByteRange | undefined): void {
  const refusal = rangeBoundsRefusal(range);

  if (refusal !== undefined) {
    throw azureBlobError(container, { ...refusal, operation: "get", attempts: 0 });
  }
}

/**
 * What refuses the answer to a range, before its body is read. Azurite answers a start at
 * the size with a `206` for no byte, where Azure answers `416 InvalidRange`, and either stays
 * the refusal of spec 4.3 for every object. An object another tool stored with a content
 * coding takes no other range, also where the range covers it: its size counts the stored
 * bytes, and `fetch` may decode them on the way (ADR 0044).
 */
export function rangeAnswerFailure(
  container: string,
  key: string,
  range: ByteRange,
  response: Response,
  size: number,
): StorageError | undefined {
  const refusal =
    rangeStartRefusal(range, size, key) ??
    contentCodingRefusal(response.headers.get("content-encoding"), key) ??
    (response.status === partialContent ? undefined : wholeAnswerRefusal(key, range, size));

  return refusal === undefined
    ? undefined
    : azureBlobError(container, {
        ...refusal,
        operation: "get",
        key,
        attempts: 1,
        status: response.status,
        requestId: response.headers.get("x-ms-request-id") ?? undefined,
      });
}

/**
 * A provider may answer a range with the whole object and `200`, which RFC 9110 allows and
 * which is the body asked for where the range covers the object.
 */
function wholeAnswerRefusal(
  key: string,
  range: ByteRange,
  size: number,
): Pick<StorageErrorFields, "code" | "message"> | undefined {
  if (rangeCoversWhole(range, size)) return undefined;

  return {
    code: "ProviderError",
    message: `The provider answered a range of the object under ${JSON.stringify(key)} with the whole of it`,
  };
}
