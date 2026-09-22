import type { ListOptions, ListPage, ObjectEntry, ObjectListing } from "@stowage/core";

import { decodeCursor, encodeCursor } from "./cursor.ts";
import { requireKey } from "./key.ts";
import { listOptionKeys, optionError, requireKnownOptions } from "./options.ts";

const defaultPageSize = 1000;
const maxPageSize = 1000;

interface ListRequest {
  readonly prefix: string;
  readonly delimiter?: string;
  readonly pageSize: number;
  /** The key the page before this one ended on. */
  readonly after?: string;
}

interface Slice {
  readonly objects: readonly ObjectEntry[];
  readonly prefixes: readonly string[];
  /** The key the slice ended on, set where entries are left below the prefix. */
  readonly after?: string;
}

/** `objectsBelow` walks the tree below the prefix and hands it over sorted by key. */
export function createListing(
  root: string,
  objectsBelow: (prefix: string) => Promise<readonly ObjectEntry[]>,
  options?: ListOptions,
): ObjectListing {
  // Neither reader touches `options` before it runs, which is what leaves `list` itself
  // without work to do and without a failure to report (spec 4.6).
  return {
    async page(): Promise<ListPage> {
      const request = read(root, options);

      options?.signal?.throwIfAborted();

      const slice = take(await objectsBelow(request.prefix), request);

      return {
        objects: slice.objects,
        prefixes: slice.prefixes,
        cursor: slice.after === undefined ? undefined : encodeCursor(slice.after),
      };
    },

    async *[Symbol.asyncIterator](): AsyncIterator<ObjectEntry> {
      const request = read(root, options);

      options?.signal?.throwIfAborted();

      // The tree is walked once and the pages are cut out of what it found: spec 4.6
      // promises nothing about an object written while the iteration runs, and a walk
      // per page would read the whole tree again for each of them.
      const entries = await objectsBelow(request.prefix);

      for (let after = request.after; ;) {
        options?.signal?.throwIfAborted();

        const slice = take(entries, { ...request, after });

        yield* slice.objects;

        if (slice.after === undefined) return;

        after = slice.after;
      }
    },
  };
}

function read(root: string, options: ListOptions | undefined): ListRequest {
  requireKnownOptions(root, options, listOptionKeys, "list");

  const prefix = options?.prefix ?? "";

  requireKey(root, prefix, "prefix", "list");

  const pageSize = options?.pageSize ?? defaultPageSize;

  if (!Number.isInteger(pageSize) || pageSize < 1 || pageSize > maxPageSize) {
    throw optionError(root, "pageSize", `takes a whole number from 1 to ${maxPageSize}`, "list");
  }

  if (options?.delimiter === "") {
    throw optionError(root, "delimiter", "takes at least one character", "list");
  }

  const after = options?.cursor === undefined ? undefined : decodeCursor(options.cursor);

  if (options?.cursor !== undefined && after === undefined) {
    throw optionError(root, "cursor", "takes a cursor this storage handed out", "list");
  }

  return { prefix, delimiter: options?.delimiter, pageSize, after };
}

function take(entries: readonly ObjectEntry[], request: ListRequest): Slice {
  const objects: ObjectEntry[] = [];
  const prefixes: string[] = [];
  let after: string | undefined;

  for (const entry of entries) {
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
