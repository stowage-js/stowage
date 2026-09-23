import type { ListOptions, ListPage, ObjectEntry, ObjectListing } from "@stowage/core";

import type { QueryParameter } from "./canonical.ts";
import type { S3Configuration } from "./configuration.ts";
import { decodeCursor, encodeCursor } from "./cursor.ts";
import { requireKey } from "./key.ts";
import { type ListingDocument, readListingDocument } from "./listing-document.ts";
import { listOptionKeys, optionError, requireKnownOptions } from "./options.ts";
import { send } from "./request.ts";
import { s3Error } from "./storage-error.ts";

// Spec 7.2: a page holds at most 1000 keys, which is what `ListObjectsV2` answers.
const defaultPageSize = 1000;
const maxPageSize = 1000;

interface ListRequest {
  readonly prefix: string;
  readonly delimiter?: string;
  readonly pageSize: number;
  /** Where the caller's cursor continues from, absent for the first page. */
  readonly continuationToken?: string;
  readonly signal?: AbortSignal;
}

/**
 * Spec 4.6: a listing sends no request until it is read, so an option it refuses reaches
 * the caller from `page()` and from the iteration and not from `list`.
 */
export function createListing(
  configuration: S3Configuration,
  options: ListOptions | undefined,
): ObjectListing {
  return {
    async page(): Promise<ListPage> {
      const request = readListRequest(configuration.bucket, options);
      const document = await listOnce(configuration, request, request.continuationToken);

      return {
        objects: document.objects,
        prefixes: document.prefixes,
        cursor:
          document.continuationToken === undefined
            ? undefined
            : encodeCursor(document.continuationToken),
      };
    },

    async *[Symbol.asyncIterator](): AsyncIterator<ObjectEntry> {
      const request = readListRequest(configuration.bucket, options);

      for (let { continuationToken } = request; ;) {
        // oxlint-disable-next-line no-await-in-loop -- the next page needs this one's token
        const document = await listOnce(configuration, request, continuationToken);

        yield* document.objects;

        if (document.continuationToken === undefined) return;

        continuationToken = document.continuationToken;
      }
    },
  };
}

/** Everything spec 4.11 has `list` refuse without asking the provider. */
function readListRequest(bucket: string, options: ListOptions | undefined): ListRequest {
  requireKnownOptions(bucket, options, listOptionKeys, "list");

  const prefix = options?.prefix ?? "";

  requireKey(bucket, prefix, "prefix", "list");

  const pageSize = options?.pageSize ?? defaultPageSize;

  if (!Number.isInteger(pageSize) || pageSize < 1 || pageSize > maxPageSize) {
    throw optionError(bucket, "pageSize", `takes a whole number from 1 to ${maxPageSize}`, "list");
  }

  if (options?.delimiter === "") {
    throw optionError(bucket, "delimiter", "takes at least one character", "list");
  }

  const cursor = options?.cursor;
  const continuationToken = cursor === undefined ? undefined : decodeCursor(cursor);

  if (cursor !== undefined && continuationToken === undefined) {
    throw optionError(bucket, "cursor", "takes a cursor this storage handed out", "list");
  }

  return {
    prefix,
    delimiter: options?.delimiter,
    pageSize,
    continuationToken,
    signal: options?.signal,
  };
}

/** One `ListObjectsV2` request, which is what one page costs. */
async function listOnce(
  configuration: S3Configuration,
  request: ListRequest,
  continuationToken?: string,
): Promise<ListingDocument> {
  // Spec 4.3: a signal that already fired rejects before the request goes out.
  request.signal?.throwIfAborted();

  const query: QueryParameter[] = [
    ["list-type", "2"],
    ["max-keys", String(request.pageSize)],
  ];

  if (request.prefix !== "") query.push(["prefix", request.prefix]);
  if (request.delimiter !== undefined) query.push(["delimiter", request.delimiter]);
  if (continuationToken !== undefined) query.push(["continuation-token", continuationToken]);

  const response = await send(configuration, {
    method: "GET",
    operation: "list",
    query,
    signal: request.signal,
  });

  return readListingDocument(configuration.bucket, await readBody(configuration.bucket, response));
}

/**
 * Spec 7.5 repeats a transport failure that received no response; this one received its
 * response and broke in the body, which spec 4.5 leaves unresumed for `get` as well.
 */
async function readBody(bucket: string, response: Response): Promise<string> {
  try {
    return await response.text();
  } catch (failure) {
    // Spec 4.10: the caller's abort travels on as the runtime's `AbortError`.
    if (failure instanceof Error && failure.name === "AbortError") throw failure;

    throw s3Error(bucket, {
      code: "NetworkError",
      message: `The listing broke while it was read: ${String(failure)}`,
      operation: "list",
      attempts: 1,
      retryable: true,
      cause: failure,
    });
  }
}
