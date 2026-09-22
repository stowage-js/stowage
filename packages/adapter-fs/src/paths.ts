import { mkdir, realpath } from "node:fs/promises";
import { basename, dirname, join, sep } from "node:path";

import type { StorageError } from "@stowage/core";

import { errnoOf, type FsAccess, fsErrorFrom, isAbsence } from "./errno.ts";
import { fsError } from "./storage-error.ts";

/** One operation, against the root every path it reaches is resolved below. */
export interface FsRootContext {
  readonly root: string;
  readonly realRoot: string;
  readonly operation: string;
}

/** The same, for the operations that name one key. */
export interface FsAccessContext extends FsRootContext {
  readonly key: string;
}

/**
 * The root as the file system resolves it, which every path an operation reaches is held
 * against. It is read afresh per operation: construction performs no I/O, and a root
 * that is gone by the time it is used is `NotFound` rather than a path of its own (spec 6).
 */
export async function resolveRoot(
  root: string,
  operation: string,
  access: FsAccess,
): Promise<string> {
  try {
    return await realpath(root);
  } catch (thrown) {
    throw fsErrorFrom(thrown, { root, operation, access });
  }
}

/** The path the key names below the root, or `undefined` where no file can carry it. */
export function pathOf(realRoot: string, key: string): string | undefined {
  const segments = key.split("/");

  // An addressable key may end in a slash (spec 4.8), and no file is named by one.
  if (segments.at(-1) === "") return undefined;

  return join(realRoot, ...segments);
}

export function within(realRoot: string, path: string): boolean {
  return path === realRoot || path.startsWith(`${realRoot}${sep}`);
}

/**
 * The key names nothing this storage holds, which is what a read of it answers. The count
 * is what it cost to find that out: one lookup, or none where the key names no file at
 * all (spec 4.10).
 */
export function absent(context: FsAccessContext, attempts: number): StorageError {
  return fsError(context.root, {
    code: "NotFound",
    message: `No object under the key ${JSON.stringify(context.key)}`,
    operation: context.operation,
    key: context.key,
    attempts,
  });
}

/**
 * The real path of the file the key names. Spec 6 has every access resolve it and answer
 * `NotFound` where it lies outside the root, so a symbolic link leaving the root behaves
 * as an absent object rather than as a way out of the storage.
 */
export async function resolveObject(context: FsAccessContext): Promise<string> {
  const path = pathOf(context.realRoot, context.key);

  // A key ending in a slash names no file, which the storage answers without asking.
  if (path === undefined) throw absent(context, 0);

  let resolved: string;

  try {
    resolved = await realpath(path);
  } catch (thrown) {
    throw fsErrorFrom(thrown, { ...context, access: "read" });
  }

  if (!within(context.realRoot, resolved)) throw absent(context, 1);

  return resolved;
}

/**
 * The path a write lands under, with the directories above it in place. The nearest
 * existing directory is resolved before anything is created, so a link leaving the root
 * cannot cause this storage to create directories outside it.
 */
export async function prepareWrite(context: FsAccessContext): Promise<string> {
  const path = pathOf(context.realRoot, context.key);

  // A writable key ends in no slash (spec 4.8), so the key names a file at this point.
  if (path === undefined) throw absent(context, 0);

  const directory = await makeDirectory(dirname(path), context);

  const target = join(directory, basename(path));

  // A link at the key leaves the root as much as one on the way to it, so the write is
  // refused rather than following it or replacing it (spec 6).
  if (!(await resolvesWithin(context, target))) throw absent(context, 1);

  return target;
}

async function resolvesWithin(context: FsAccessContext, path: string): Promise<boolean> {
  try {
    return within(context.realRoot, await realpath(path));
  } catch (thrown) {
    // Nothing is there yet, which is what a write to a key finds most of the time.
    if (isAbsence(thrown)) return true;

    throw fsErrorFrom(thrown, { ...context, access: "write" });
  }
}

async function makeDirectory(directory: string, context: FsAccessContext): Promise<string> {
  const missing: string[] = [];
  let existing = directory;

  // Find and validate the closest path that exists before a mkdir can touch anything.
  for (;;) {
    try {
      // oxlint-disable-next-line no-await-in-loop -- each absence selects the next parent
      existing = await realpath(existing);
      break;
    } catch (thrown) {
      if (!isAbsence(thrown)) {
        throw fsErrorFrom(thrown, { ...context, access: "write" });
      }

      missing.unshift(basename(existing));
      existing = dirname(existing);
    }
  }

  if (!within(context.realRoot, existing)) throw absent(context, 1);

  // A non-recursive mkdir does not follow a link at the segment it creates. Resolving
  // each result also catches a segment another actor placed between the checks.
  for (const segment of missing) {
    const path = join(existing, segment);

    try {
      // oxlint-disable-next-line no-await-in-loop -- one path, created from the root down
      await mkdir(path);
    } catch (thrown) {
      // EEXIST can mean another actor created this segment. Its real path is checked
      // below; a regular file is reported when the next segment or temporary file is made.
      if (errnoOf(thrown) !== "EEXIST") {
        throw fsErrorFrom(thrown, { ...context, access: "write" });
      }
    }

    try {
      // oxlint-disable-next-line no-await-in-loop -- each segment guards the next mkdir
      existing = await realpath(path);
    } catch (thrown) {
      throw fsErrorFrom(thrown, { ...context, access: "write" });
    }

    if (!within(context.realRoot, existing)) throw absent(context, 1);
  }

  return existing;
}
