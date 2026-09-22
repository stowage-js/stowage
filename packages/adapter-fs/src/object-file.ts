import type { Stats } from "node:fs";
import { lstat, realpath, rmdir, stat, unlink } from "node:fs/promises";
import { basename, dirname, join } from "node:path";

import { fsErrorFrom, isAbsence } from "./errno.ts";
import { type FsAccessContext, pathOf, within } from "./paths.ts";

/**
 * The file one key names, as the operations that act on the file itself reach it: the
 * path below the root and not the path it resolves to, so that removing or moving a key
 * holding a link takes the link and leaves the object it points to where it is.
 */
export interface ObjectFile {
  readonly path: string;
  readonly stats: Stats;
}

/**
 * The file below the key, or `undefined` where the key names no object of this storage:
 * nothing at all, a directory, or a path that leaves the root (spec 6). What a listing
 * passes over is what these operations find nothing under.
 */
export async function findObjectFile(context: FsAccessContext): Promise<ObjectFile | undefined> {
  const path = pathOf(context.realRoot, context.key);

  // An addressable key may end in a slash (spec 4.8), and no file is named by one.
  if (path === undefined) return undefined;

  const directory = await resolveWithin(context, dirname(path));

  if (directory === undefined) return undefined;

  const target = join(directory, basename(path));
  const held = await describe(context, target);

  return held?.isFile() === true ? { path: target, stats: held } : undefined;
}

/**
 * Removes the file and the directories it leaves empty behind it, so that a listing with
 * a delimiter names no pseudo-directory that holds nothing (spec 6).
 */
export async function removeObjectFile(context: FsAccessContext, file: ObjectFile): Promise<void> {
  try {
    await unlink(file.path);
  } catch (thrown) {
    // Another caller removing the same key between the lookup and this is the ordinary
    // race, and its winner leaves this one the answer it was after (spec 4.7).
    if (!isAbsence(thrown)) throw fsErrorFrom(thrown, { ...context, access: "write" });
  }

  await pruneEmptyDirectories(context.realRoot, dirname(file.path));
}

async function pruneEmptyDirectories(realRoot: string, directory: string): Promise<void> {
  for (
    let current = directory;
    current !== realRoot && within(realRoot, current);
    current = dirname(current)
  ) {
    try {
      // oxlint-disable-next-line no-await-in-loop -- one branch, emptied from the leaf up
      await rmdir(current);
    } catch {
      // The first directory that stays ends the walk, whether because another writer put
      // an object in it or because this storage may not remove it: the object is gone
      // either way, and nothing above a directory that holds something is empty.
      return;
    }
  }
}

/** What the path holds, or `undefined` where nothing is there or a link leaves the root. */
async function describe(context: FsAccessContext, path: string): Promise<Stats | undefined> {
  const held = await lookUp(context, async () => await lstat(path));

  if (held === undefined || !held.isSymbolicLink()) return held;

  const resolved = await resolveWithin(context, path);

  return resolved === undefined
    ? undefined
    : await lookUp(context, async () => await stat(resolved));
}

/** The path as the file system resolves it, where that lies below the root (spec 6). */
async function resolveWithin(context: FsAccessContext, path: string): Promise<string | undefined> {
  const resolved = await lookUp(context, async () => await realpath(path));

  return resolved !== undefined && within(context.realRoot, resolved) ? resolved : undefined;
}

/** A lookup whose answer for a path that is not there is that nothing is there. */
async function lookUp<T>(context: FsAccessContext, read: () => Promise<T>): Promise<T | undefined> {
  try {
    return await read();
  } catch (thrown) {
    if (isAbsence(thrown)) return undefined;

    throw fsErrorFrom(thrown, { ...context, access: "write" });
  }
}
