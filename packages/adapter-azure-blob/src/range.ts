import {
  type ByteRange,
  rangeBoundsRefusal,
  rangeCoversWhole,
  rangeStartRefusal,
  type StorageError,
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
 * What an answer to a range means where it is not the range asked for. Azurite answers a
 * start at the size with a `206` for no byte, where Azure answers `416 InvalidRange`; a
 * provider may answer with the whole object and `200`, which RFC 9110 allows and which is
 * the body asked for where the range covers the object.
 */
export function rangeAnswerFailure(
  container: string,
  key: string,
  range: ByteRange,
  response: Response,
  size: number,
): StorageError | undefined {
  if (response.status === partialContent) return startsBeyond(container, key, range, size);

  if (rangeCoversWhole(range, size)) return undefined;

  return (
    startsBeyond(container, key, range, size) ??
    azureBlobError(container, {
      code: "ProviderError",
      message: `The provider answered a range of the object under ${JSON.stringify(key)} with the whole of it`,
      operation: "get",
      key,
      attempts: 1,
    })
  );
}

function startsBeyond(
  container: string,
  key: string,
  range: ByteRange,
  size: number,
): StorageError | undefined {
  const refusal = rangeStartRefusal(range, size, key);

  return refusal === undefined
    ? undefined
    : azureBlobError(container, { ...refusal, operation: "get", key, attempts: 1 });
}
