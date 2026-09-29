import type {
  ListOptions,
  ListPage,
  ObjectEntry,
  ObjectListing,
  StorageError,
} from "@stowage/core";

import type { GcsConfiguration } from "./configuration.ts";
import { decodeCursor, encodeCursor } from "./cursor.ts";
import { etagOf, fieldOf, lastModifiedOf, sizeOf } from "./description.ts";
import { requireKey } from "./key.ts";
import { listOptionKeys, optionError, requireKnownOptions } from "./options.ts";
import { listPath, type QueryParameter, requestIdHeader, send } from "./request.ts";
import { gcsError } from "./storage-error.ts";

// Spec 9.2: a page holds at most 1000 names, which is what `objects.list` answers.
const defaultPageSize = 1000;
const maxPageSize = 1000;

interface ListRequest {
  readonly operation: string;
  readonly prefix: string;
  readonly delimiter?: string;
  readonly pageSize: number;
  /** The token the page continues from: the caller's cursor, then each `nextPageToken`. */
  readonly pageToken?: string;
  readonly signal?: AbortSignal;
}

interface ListingDocument {
  readonly objects: readonly ObjectEntry[];
  readonly prefixes: readonly string[];
  /** The provider's own position, set where the listing goes on past this page. */
  readonly nextPageToken?: string;
}

/**
 * Spec 4.6: a listing sends no request until it is read, so an option it refuses reaches
 * the caller from `page()` and from the iteration and not from `list`.
 */
export function createListing(
  configuration: GcsConfiguration,
  options: ListOptions | undefined,
): ObjectListing {
  return {
    async page(): Promise<ListPage> {
      const request = readListRequest(configuration.bucket, options);
      const document = await requestPage(configuration, request, callersCursor(request));

      return {
        objects: document.objects,
        prefixes: document.prefixes,
        cursor:
          document.nextPageToken === undefined ? undefined : encodeCursor(document.nextPageToken),
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

/** Every page of the listing from where the request starts to its end. */
async function* walkPages(
  configuration: GcsConfiguration,
  request: ListRequest,
): AsyncGenerator<ListingDocument> {
  let document = await requestPage(configuration, request, callersCursor(request));

  yield document;

  while (document.nextPageToken !== undefined) {
    const next = { ...request, pageToken: document.nextPageToken };

    // oxlint-disable-next-line no-await-in-loop -- the next page needs this one's token
    document = await requestPage(configuration, next, false);

    yield document;
  }
}

/** Whether the first page continues from a cursor the caller handed over. */
function callersCursor(request: ListRequest): boolean {
  return request.pageToken !== undefined;
}

/** Everything spec 4.3 and 4.11 have `list` refuse without asking the provider. */
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
  const pageToken = cursor === undefined ? undefined : decodeCursor(cursor);

  if (cursor !== undefined && pageToken === undefined) {
    throw optionError(bucket, "cursor", "takes a cursor this storage handed out", "list");
  }

  return {
    operation: "list",
    prefix,
    delimiter: options?.delimiter,
    pageSize,
    pageToken,
    signal: options?.signal,
  };
}

/**
 * One page. `carriesCursor` says whether its page token is the caller's rather than one the
 * provider handed out on the way, since spec 9.8 has only the caller's refused as `cursor`.
 */
async function requestPage(
  configuration: GcsConfiguration,
  request: ListRequest,
  carriesCursor: boolean,
): Promise<ListingDocument> {
  // Spec 4.3: a signal that already fired rejects before the request goes out.
  request.signal?.throwIfAborted();

  const query: QueryParameter[] = [["maxResults", String(request.pageSize)]];

  if (request.prefix !== "") query.push(["prefix", request.prefix]);
  if (request.delimiter !== undefined) query.push(["delimiter", request.delimiter]);
  if (request.pageToken !== undefined) query.push(["pageToken", request.pageToken]);

  const response = await send(configuration, {
    method: "GET",
    operation: request.operation,
    path: listPath(configuration),
    query,
    carriesCursor,
    signal: request.signal,
  });
  const answer: ListingAnswer = {
    bucket: configuration.bucket,
    operation: request.operation,
    response,
  };

  const document = readListingDocument(answer, await readListingBody(answer));

  // A listing that continues from where it was sent would walk the same page forever.
  if (document.nextPageToken !== undefined && document.nextPageToken === request.pageToken) {
    throw malformedListing(answer, "the page token it was sent");
  }

  return document;
}

/** What a failure to read the listing is told against. */
interface ListingAnswer {
  readonly bucket: string;
  readonly operation: string;
  readonly response: Response;
}

async function readListingBody(answer: ListingAnswer): Promise<unknown> {
  try {
    return await answer.response.json();
  } catch (failure) {
    if (failure instanceof Error && failure.name === "AbortError") throw failure;

    throw malformedListing(answer, "a body that is no JSON", failure);
  }
}

/**
 * Spec 4.6 makes an entry that arrives without a key, a size or a last-modified time a
 * `ProviderError`, which leaves the page unread rather than hand the caller a value made up
 * for what was missing.
 */
function readListingDocument(answer: ListingAnswer, document: unknown): ListingDocument {
  return {
    objects: arrayOf(fieldOf(document, "items")).map((item) => readEntry(answer, item)),
    prefixes: arrayOf(fieldOf(document, "prefixes")).map((prefix) => {
      if (typeof prefix !== "string" || prefix === "") {
        throw malformedListing(answer, "a pseudo-directory with no name");
      }

      return prefix;
    }),
    nextPageToken: stringOf(fieldOf(document, "nextPageToken")),
  };
}

function readEntry(answer: ListingAnswer, item: unknown): ObjectEntry {
  const key = stringOf(fieldOf(item, "name"));

  if (key === undefined) throw malformedListing(answer, "an object with no key");

  const size = sizeOf(item);

  if (size === undefined) {
    throw malformedListing(answer, `the object under ${JSON.stringify(key)} with no size`);
  }

  const lastModified = lastModifiedOf(item);

  if (lastModified === undefined) {
    throw malformedListing(
      answer,
      `the object under ${JSON.stringify(key)} with no last-modified time`,
    );
  }

  return { key, size, lastModified, ...etagOf(item) };
}

function malformedListing(answer: ListingAnswer, what: string, cause?: unknown): StorageError {
  return gcsError(answer.bucket, {
    code: "ProviderError",
    message: `The provider answered the listing with ${what}`,
    operation: answer.operation,
    attempts: 1,
    status: answer.response.status,
    requestId: answer.response.headers.get(requestIdHeader) ?? undefined,
    cause,
  });
}

function arrayOf(value: unknown): readonly unknown[] {
  return Array.isArray(value) ? value : [];
}

function stringOf(value: unknown): string | undefined {
  return typeof value === "string" && value !== "" ? value : undefined;
}
