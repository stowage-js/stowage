import type { ListOptions, ListPage, ObjectEntry, ObjectListing } from "@stowage/core";

import type { AzureBlobConfiguration } from "./configuration.ts";
import { decodeCursor, encodeCursor } from "./cursor.ts";
import { requireKey } from "./key.ts";
import {
  type ListingAnswer,
  type ListingDocument,
  readListingDocument,
} from "./listing-document.ts";
import { listOptionKeys, optionError, requireKnownOptions } from "./options.ts";
import { send } from "./request.ts";
import type { QueryParameter } from "./sign.ts";
import { azureBlobError } from "./storage-error.ts";

// Spec 8.2: a page holds at most 1000 names, which is what `List Blobs` answers.
const defaultPageSize = 1000;
const maxPageSize = 1000;

interface ListRequest {
  readonly prefix: string;
  readonly delimiter?: string;
  readonly pageSize: number;
  /** Where the caller's cursor continues from, absent for the first page. */
  readonly marker?: string;
  readonly signal?: AbortSignal;
}

/**
 * Spec 4.6: a listing sends no request until it is read, so an option it refuses reaches
 * the caller from `page()` and from the iteration and not from `list`.
 */
export function createListing(
  configuration: AzureBlobConfiguration,
  options: ListOptions | undefined,
): ObjectListing {
  return {
    async page(): Promise<ListPage> {
      const document = await requestPage(
        configuration,
        readListRequest(configuration.container, options),
      );

      return {
        objects: document.objects,
        prefixes: document.prefixes,
        cursor: document.nextMarker === undefined ? undefined : encodeCursor(document.nextMarker),
      };
    },

    async *[Symbol.asyncIterator](): AsyncIterator<ObjectEntry> {
      for await (const document of walkPages(
        configuration,
        readListRequest(configuration.container, options),
      )) {
        yield* document.objects;
      }
    },
  };
}

/** Every page of the listing from where the request starts to its end. */
async function* walkPages(
  configuration: AzureBlobConfiguration,
  request: ListRequest,
): AsyncGenerator<ListingDocument> {
  for (let { marker } = request; ;) {
    // oxlint-disable-next-line no-await-in-loop -- the next page needs this one's marker
    const document = await requestPage(configuration, { ...request, marker });

    if (document.nextMarker !== undefined && document.nextMarker === marker) {
      throw azureBlobError(configuration.container, {
        code: "ProviderError",
        message: "The provider repeated the marker it was sent",
        operation: "list",
        attempts: 1,
      });
    }

    yield document;

    if (document.nextMarker === undefined) return;

    marker = document.nextMarker;
  }
}

/** Everything spec 4.11 has `list` refuse without asking the provider. */
function readListRequest(container: string, options: ListOptions | undefined): ListRequest {
  requireKnownOptions(container, options, listOptionKeys, "list");

  const prefix = options?.prefix ?? "";

  requireKey(container, prefix, "prefix", "list");

  const pageSize = options?.pageSize ?? defaultPageSize;

  if (!Number.isInteger(pageSize) || pageSize < 1 || pageSize > maxPageSize) {
    throw optionError(
      container,
      "pageSize",
      `takes a whole number from 1 to ${maxPageSize}`,
      "list",
    );
  }

  if (options?.delimiter === "") {
    throw optionError(container, "delimiter", "takes at least one character", "list");
  }

  const cursor = options?.cursor;
  const marker = cursor === undefined ? undefined : decodeCursor(cursor);

  if (cursor !== undefined && marker === undefined) {
    throw optionError(container, "cursor", "takes a cursor this storage handed out", "list");
  }

  return { prefix, delimiter: options?.delimiter, pageSize, marker, signal: options?.signal };
}

async function requestPage(
  configuration: AzureBlobConfiguration,
  request: ListRequest,
): Promise<ListingDocument> {
  // Spec 4.3: a signal that already fired rejects before the request goes out.
  request.signal?.throwIfAborted();

  const query: QueryParameter[] = [
    ["restype", "container"],
    ["comp", "list"],
    ["maxresults", String(request.pageSize)],
  ];

  if (request.prefix !== "") query.push(["prefix", request.prefix]);
  if (request.delimiter !== undefined) query.push(["delimiter", request.delimiter]);
  if (request.marker !== undefined) query.push(["marker", request.marker]);

  const response = await send(configuration, {
    method: "GET",
    operation: "list",
    query,
    signal: request.signal,
  });

  const answer: ListingAnswer = {
    container: configuration.container,
    status: response.status,
    requestId: response.headers.get("x-ms-request-id") ?? undefined,
  };

  return readListingDocument(answer, await readBody(answer, response));
}

/**
 * Spec 8.5 repeats a transport failure that received no response; this one received its
 * response and broke in the body, which spec 4.5 leaves unresumed for `get` as well.
 */
async function readBody(answer: ListingAnswer, response: Response): Promise<string> {
  try {
    return await response.text();
  } catch (failure) {
    // Spec 4.10: the caller's abort travels on as the runtime's `AbortError`.
    if (failure instanceof Error && failure.name === "AbortError") throw failure;

    throw azureBlobError(answer.container, {
      code: "NetworkError",
      message: `The listing broke while it was read: ${String(failure)}`,
      operation: "list",
      attempts: 1,
      status: answer.status,
      requestId: answer.requestId,
      retryable: true,
      cause: failure,
    });
  }
}
