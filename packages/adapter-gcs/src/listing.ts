import type { ListOptions, ListPage, ObjectEntry, ObjectListing } from "@stowage/core";

import { type AnsweredRequest, malformedAnswer, readAnswerJson } from "./answer.ts";
import type { GcsConfiguration } from "./configuration.ts";
import { decodeCursor, encodeCursor } from "./cursor.ts";
import { etagOf, lastModifiedOf, sizeOf } from "./description.ts";
import { arrayOf, fieldOf, stringOf } from "./json.ts";
import { requireKey } from "./key.ts";
import { listOptionKeys, optionError, requireKnownOptions } from "./options.ts";
import { listPath, type QueryParameter, send } from "./request.ts";

// Spec 9.2: a page holds at most 1000 names, which is what `objects.list` answers.
const defaultPageSize = 1000;
export const maxPageSize = 1000;

interface ListRequest {
  readonly operation: string;
  readonly prefix: string;
  readonly delimiter?: string;
  readonly pageSize: number;
  /** The token the page continues from: the caller's cursor, then each `nextPageToken`. */
  readonly pageToken?: string;
  /**
   * Whether `pageToken` is the caller's cursor rather than a token the provider handed out
   * on the way, which is the one a refusal of spec 9.8 reports as `cursor`: the caller can
   * act on the cursor they handed over, and on a token they never saw they cannot.
   */
  readonly carriesCursor: boolean;
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
      const document = await requestPage(
        configuration,
        readListRequest(configuration.bucket, options),
      );

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
export async function* walkPages(
  configuration: GcsConfiguration,
  request: ListRequest,
): AsyncGenerator<ListingDocument> {
  const sentTokens = new Set<string>();

  for (let page = request; ;) {
    if (page.pageToken !== undefined) sentTokens.add(page.pageToken);

    // oxlint-disable-next-line no-await-in-loop -- the next page needs this one's token
    const document = await requestPage(configuration, page, sentTokens);

    yield document;

    if (document.nextPageToken === undefined) return;

    page = { ...page, pageToken: document.nextPageToken, carriesCursor: false };
  }
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
    carriesCursor: pageToken !== undefined,
    signal: options?.signal,
  };
}

async function requestPage(
  configuration: GcsConfiguration,
  request: ListRequest,
  sentTokens?: ReadonlySet<string>,
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
    carriesCursor: request.carriesCursor,
    signal: request.signal,
  });
  const answered: AnsweredRequest = {
    bucket: configuration.bucket,
    operation: request.operation,
    subject: "the listing",
    response,
  };
  const document = readListingDocument(answered, await readAnswerJson(answered));

  // A listing that continues from where it was sent would walk the same page forever.
  if (document.nextPageToken !== undefined && document.nextPageToken === request.pageToken) {
    throw malformedAnswer(answered, "the page token it was sent");
  }

  if (document.nextPageToken !== undefined && sentTokens?.has(document.nextPageToken)) {
    throw malformedAnswer(answered, "a page token already sent");
  }

  return document;
}

/**
 * Spec 4.6 makes an entry that arrives without a key, a size or a last-modified time a
 * `ProviderError`, which leaves the page unread rather than hand the caller a value made up
 * for what was missing.
 */
function readListingDocument(answered: AnsweredRequest, document: unknown): ListingDocument {
  const items = fieldOf(document, "items");
  const prefixes = fieldOf(document, "prefixes");
  const nextPageToken = fieldOf(document, "nextPageToken");

  if (items !== undefined && !Array.isArray(items)) {
    throw malformedAnswer(answered, "items that are not an array");
  }

  if (prefixes !== undefined && !Array.isArray(prefixes)) {
    throw malformedAnswer(answered, "prefixes that are not an array");
  }

  if (nextPageToken !== undefined && typeof nextPageToken !== "string") {
    throw malformedAnswer(answered, "a nextPageToken that is not a string");
  }

  return {
    objects: arrayOf(items).map((item) => readEntry(answered, item)),
    prefixes: arrayOf(prefixes).map((prefix) => {
      if (typeof prefix !== "string" || prefix === "") {
        throw malformedAnswer(answered, "a pseudo-directory with no name");
      }

      return prefix;
    }),
    nextPageToken: stringOf(nextPageToken),
  };
}

function readEntry(answered: AnsweredRequest, item: unknown): ObjectEntry {
  const key = stringOf(fieldOf(item, "name"));

  if (key === undefined) throw malformedAnswer(answered, "an object with no key");

  const size = sizeOf(item);

  if (size === undefined) {
    throw malformedAnswer(answered, `the object under ${JSON.stringify(key)} with no size`);
  }

  const lastModified = lastModifiedOf(item);

  if (lastModified === undefined) {
    throw malformedAnswer(
      answered,
      `the object under ${JSON.stringify(key)} with no last-modified time`,
    );
  }

  return { key, size, lastModified, ...etagOf(item) };
}
