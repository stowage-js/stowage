import type { ListOptions, ListPage, ObjectEntry, ObjectListing } from "@stowage/core";

import type { QueryParameter } from "./canonical.ts";
import type { S3Configuration } from "./configuration.ts";
import { decodeCursor, encodeCursor } from "./cursor.ts";
import { requireKey } from "./key.ts";
import {
  type ListingAnswer,
  type ListingDocument,
  readListingDocument,
} from "./listing-document.ts";
import { listOptionKeys, optionError, requireKnownOptions } from "./options.ts";
import { send } from "./request.ts";
import { s3Error } from "./storage-error.ts";

// Spec 7.2: a page holds at most 1000 keys, which is what `ListObjectsV2` answers.
const defaultPageSize = 1000;
export const maxPageSize = 1000;

export interface ListRequest {
  /** The operation the caller invoked, which lists on its own for `deleteAll`. */
  readonly operation: string;
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
      const document = await requestPage(configuration, request);

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
      for await (const document of walkPages(
        configuration,
        readListRequest(configuration.bucket, options),
      )) {
        yield* document.objects;
      }
    },
  };
}

/**
 * Every page of the listing from where the request starts to its end, which `list`
 * iterates and `deleteAll` deletes page by page as it arrives.
 */
export async function* walkPages(
  configuration: S3Configuration,
  request: ListRequest,
): AsyncGenerator<ListingDocument> {
  for (let { continuationToken } = request; ;) {
    // oxlint-disable-next-line no-await-in-loop -- the next page needs this one's token
    const document = await requestPage(configuration, { ...request, continuationToken });

    if (
      document.continuationToken !== undefined &&
      document.continuationToken === continuationToken
    ) {
      throw s3Error(configuration.bucket, {
        code: "ProviderError",
        message: "The provider repeated the continuation token it was sent",
        operation: request.operation,
        attempts: 1,
      });
    }

    yield document;

    if (document.continuationToken === undefined) return;

    continuationToken = document.continuationToken;
  }
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
    operation: "list",
    prefix,
    delimiter: options?.delimiter,
    pageSize,
    continuationToken,
    signal: options?.signal,
  };
}

async function requestPage(
  configuration: S3Configuration,
  request: ListRequest,
): Promise<ListingDocument> {
  // Spec 4.3: a signal that already fired rejects before the request goes out.
  request.signal?.throwIfAborted();

  const query: QueryParameter[] = [
    ["list-type", "2"],
    ["max-keys", String(request.pageSize)],
    // Spec 7.4: XML carries a key holding U+FFFE neither raw nor as a reference, and a
    // percent-encoded key keeps every character out of the document (ADR 0027).
    ["encoding-type", "url"],
  ];

  if (request.prefix !== "") query.push(["prefix", request.prefix]);
  if (request.delimiter !== undefined) query.push(["delimiter", request.delimiter]);
  if (request.continuationToken !== undefined) {
    query.push(["continuation-token", request.continuationToken]);
  }

  const response = await send(configuration, {
    method: "GET",
    operation: request.operation,
    query,
    signal: request.signal,
  });

  const answer: ListingAnswer = {
    bucket: configuration.bucket,
    operation: request.operation,
    status: response.status,
    requestId: response.headers.get("x-amz-request-id") ?? undefined,
  };

  return readListingDocument(answer, await readBody(answer, response));
}

/**
 * Spec 7.5 repeats a transport failure that received no response; this one received its
 * response and broke in the body, which spec 4.5 leaves unresumed for `get` as well.
 */
async function readBody(answer: ListingAnswer, response: Response): Promise<string> {
  try {
    return await response.text();
  } catch (failure) {
    // Spec 4.10: the caller's abort travels on as the runtime's `AbortError`.
    if (failure instanceof Error && failure.name === "AbortError") throw failure;

    throw s3Error(answer.bucket, {
      code: "NetworkError",
      message: `The listing broke while it was read: ${String(failure)}`,
      operation: answer.operation,
      attempts: 1,
      status: answer.status,
      requestId: answer.requestId,
      retryable: true,
      cause: failure,
    });
  }
}
