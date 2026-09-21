import type {
  ListOptions,
  ListPage,
  ObjectEntry,
  ObjectListing,
  StorageError,
} from "@stowage/core";

import { decodeCursor, encodeCursor } from "./cursor.ts";
import { requireKey } from "./key.ts";
import { listOptionKeys, requireKnownOptions } from "./options.ts";
import { memoryError } from "./storage-error.ts";

const defaultPageSize = 1000;
const maxPageSize = 1000;

interface ListRequest {
  readonly prefix: string;
  readonly delimiter?: string;
  readonly pageSize: number;
  readonly after?: string;
}

interface Slice {
  readonly objects: readonly ObjectEntry[];
  readonly prefixes: readonly string[];
  /** The key the slice ended on, set where entries are left below the prefix. */
  readonly after?: string;
}

/** `readEntries` hands over the whole storage sorted by key, afresh for every page. */
export function createListing(
  readEntries: () => readonly ObjectEntry[],
  options?: ListOptions,
): ObjectListing {
  // Neither reader touches `options` before it runs, which is what leaves `list` itself
  // without work to do and without a failure to report (spec 4.6).
  return {
    async page(): Promise<ListPage> {
      const request = read(options);

      options?.signal?.throwIfAborted();

      const slice = take(readEntries(), request);

      return {
        objects: slice.objects,
        prefixes: slice.prefixes,
        cursor: slice.after === undefined ? undefined : encodeCursor(slice.after),
      };
    },

    async *[Symbol.asyncIterator](): AsyncIterator<ObjectEntry> {
      const request = read(options);

      for (let after = request.after; ;) {
        options?.signal?.throwIfAborted();

        const slice = take(readEntries(), { ...request, after });

        yield* slice.objects;

        if (slice.after === undefined) return;

        after = slice.after;
      }
    },
  };
}

function read(options: ListOptions | undefined): ListRequest {
  requireKnownOptions(options, listOptionKeys, "list");

  const prefix = options?.prefix ?? "";

  requireKey(prefix, "prefix", "list");

  const pageSize = options?.pageSize ?? defaultPageSize;

  if (!Number.isInteger(pageSize) || pageSize < 1 || pageSize > maxPageSize) {
    throw optionError("pageSize", `takes a whole number from 1 to ${maxPageSize}`);
  }

  if (options?.delimiter === "") throw optionError("delimiter", "takes at least one character");

  const after = options?.cursor === undefined ? undefined : decodeCursor(options.cursor);

  if (options?.cursor !== undefined && after === undefined) {
    throw optionError("cursor", "takes a cursor this storage handed out");
  }

  return { prefix, delimiter: options?.delimiter, pageSize, after };
}

function take(entries: readonly ObjectEntry[], request: ListRequest): Slice {
  const objects: ObjectEntry[] = [];
  const prefixes: string[] = [];
  let after: string | undefined;

  for (const entry of entries) {
    if (!entry.key.startsWith(request.prefix)) continue;
    if (request.after !== undefined && entry.key <= request.after) continue;

    const pseudoDirectory = pseudoDirectoryOf(entry.key, request);

    // The entries are sorted, so every key of one pseudo-directory arrives in a run and
    // the one before it is enough to tell the run's first key from the rest.
    if (pseudoDirectory !== undefined && prefixes.at(-1) === pseudoDirectory) {
      after = entry.key;
      continue;
    }

    // A pseudo-directory costs a slot of the page as an object does, so that a level of
    // many pseudo-directories pages the way S3 pages it. Spec 4.6 bounds the objects of a
    // page alone, and `flow/3-file-browser` is what reads it this way.
    if (objects.length + prefixes.length === request.pageSize) return { objects, prefixes, after };

    if (pseudoDirectory === undefined) objects.push(entry);
    else prefixes.push(pseudoDirectory);

    after = entry.key;
  }

  return { objects, prefixes };
}

function pseudoDirectoryOf(key: string, { prefix, delimiter }: ListRequest): string | undefined {
  if (delimiter === undefined) return undefined;

  const end = key.indexOf(delimiter, prefix.length);

  return end === -1 ? undefined : key.slice(0, end + delimiter.length);
}

// The message names the option and never the value it refused (spec 4.3).
function optionError(option: string, expectation: string): StorageError {
  return memoryError({
    code: "InvalidOption",
    message: `The option \`${option}\` ${expectation}`,
    operation: "list",
    attempts: 0,
  });
}
