import type { Stats } from "node:fs";
import { link, lstat, realpath, rename, rmdir, stat, unlink } from "node:fs/promises";
import { basename, dirname, join } from "node:path";

import type { StorageError } from "@stowage/core";

import { holdDirectoryMutations } from "./directory-lock.ts";
import {
  asFailure,
  errnoOf,
  fsErrorFrom,
  isAbsence,
  refusesHardLinks,
  refusesName,
} from "./errno.ts";
import { absent, type FsAccessContext, pathOf, within } from "./paths.ts";
import { fsError } from "./storage-error.ts";

/**
 * The file one key names, as the operations that act on the file itself reach it: the
 * path below the root and not the path it resolves to, so that removing or moving a key
 * holding a link takes the link and leaves the object it points to where it is.
 */
export interface ObjectFile {
  readonly path: string;
  readonly stats: Stats;
  readonly release: () => void;
}

/**
 * The file below the key, or `undefined` where the key names no object of this storage:
 * nothing at all, a directory, or a path that leaves the root (spec 6). What a listing
 * passes over is what these operations find nothing under.
 */
export async function findObjectFile(context: FsAccessContext): Promise<ObjectFile | undefined> {
  const release = await holdDirectoryMutations(context.realRoot);

  try {
    const path = pathOf(context.realRoot, context.key);

    // An addressable key may end in a slash (spec 4.8), and no file is named by one.
    if (path === undefined) {
      release();
      return undefined;
    }

    const directory = await resolveWithin(context, dirname(path));

    if (directory === undefined) {
      release();
      return undefined;
    }

    const target = join(directory, basename(path));
    const held = await describe(context, target);

    if (held?.isFile() !== true) {
      release();
      return undefined;
    }

    return { path: target, stats: held, release };
  } catch (thrown) {
    release();
    throw thrown;
  }
}

/** Releases the parent-directory lease after a read-only use of the found object. */
export function releaseObjectFile(file: ObjectFile): void {
  file.release();
}

/**
 * Removes the file and the directories it leaves empty behind it, so that a listing with
 * a delimiter names no pseudo-directory that holds nothing (spec 6).
 */
export async function removeObjectFile(context: FsAccessContext, file: ObjectFile): Promise<void> {
  try {
    try {
      await unlink(file.path);
    } catch (thrown) {
      // Another caller removing the same key between the lookup and this is the ordinary
      // race, and its winner leaves this one the answer it was after (spec 4.7).
      if (!isAbsence(thrown)) throw fsErrorFrom(thrown, { ...context, access: "write" });
    }

    await pruneEmptyDirectories(context.realRoot, dirname(file.path));
  } finally {
    file.release();
  }
}

/**
 * Moves the file to the path, which is the copy and the delete of spec 4.11 as one file
 * system performs them, and removes what the source left empty behind it.
 */
export async function renameObjectFile(
  context: FsAccessContext,
  file: ObjectFile,
  destination: WriteDestination,
): Promise<void> {
  try {
    await rename(file.path, destination.path);
  } catch (thrown) {
    // Spec 4.10 has a failure name the key it concerns. The source already holds its name,
    // so a name the file system refuses is the destination's, and anything else the rename
    // refuses concerns the file it takes away from the source. The lease stays with the
    // caller, which still has to take back the directories it created for the destination
    // before anyone else may remove or reuse them.
    throw fsErrorFrom(thrown, { ...concernedBy(thrown, context, destination), access: "write" });
  }

  // POSIX has a rename between two names of one file leave both in place, and a conditional
  // `move` of a key holding a link leaves two keys naming one file (ADR 0072).
  if (await namesOneFile(context, file.path, destination)) await unlinkSource(context, file);

  await leaveSource(context, file);
}

/**
 * Moves the file to the path where that path holds nothing yet: links it there, then removes
 * it under the source, so that between the two steps the object is under both keys (spec 6).
 * A key holding a symbolic link has the file it resolves to linked, since macOS `link` follows
 * a link and Linux does not, and the destination holds the same bytes on both (ADR 0072).
 */
export async function linkObjectFile(
  context: FsAccessContext,
  file: ObjectFile,
  destination: WriteDestination,
): Promise<void> {
  const resolved = await resolveWithin(context, file.path);

  // The source went away since it was found, removed by a writer outside this process.
  if (resolved === undefined) throw absent(context, 1);

  try {
    await linkWhereAbsent(resolved, destination);
  } catch (thrown) {
    // The lease stays with the caller, as after a refused rename.
    throw asFailure(thrown, { ...concernedBy(thrown, context, destination), access: "write" });
  }

  await unlinkSource(context, file);
  await leaveSource(context, file);
}

/**
 * The key a failed move names. The source already holds its name, so a name the file system
 * refuses is the destination's, and anything else concerns the file taken from the source.
 */
function concernedBy(
  thrown: unknown,
  context: FsAccessContext,
  destination: WriteDestination,
): FsAccessContext {
  return refusesName(thrown) ? destination.context : context;
}

/** Whether the source still names the file the destination now names. */
async function namesOneFile(
  context: FsAccessContext,
  source: string,
  destination: WriteDestination,
): Promise<boolean> {
  const left = await lookUp(context, async () => await lstat(source));

  if (left === undefined) return false;

  const landed = await lookUp(destination.context, async () => await lstat(destination.path));

  return landed?.ino === left.ino && landed.dev === left.dev;
}

/** Removes the source once the destination holds the file. */
async function unlinkSource(context: FsAccessContext, file: ObjectFile): Promise<void> {
  try {
    await unlink(file.path);
  } catch (thrown) {
    // Spec 4.10: the delete failed, and the destination stays where it landed.
    if (!isAbsence(thrown)) throw fsErrorFrom(thrown, { ...context, access: "write" });
  }
}

/** Removes what the source left empty behind it, and hands back the lease. */
async function leaveSource(context: FsAccessContext, file: ObjectFile): Promise<void> {
  try {
    await pruneEmptyDirectories(context.realRoot, dirname(file.path));
  } finally {
    file.release();
  }
}

/** Where a write puts the file it lands, together with the key that names it. */
export interface WriteDestination {
  readonly context: FsAccessContext;
  readonly path: string;
}

/**
 * Puts the file under the path where the path holds nothing yet. `link(2)` refuses a name
 * that holds anything, atomically against every other process, where `rename` replaces it
 * (ADR 0072). What spec 6 names for a refused `link` rejects as that, and every other failure
 * as the syscall threw it.
 */
export async function linkWhereAbsent(file: string, destination: WriteDestination): Promise<void> {
  try {
    await link(file, destination.path);
  } catch (thrown) {
    throw (await linkRefusal(thrown, destination)) ?? thrown;
  }
}

async function linkRefusal(
  thrown: unknown,
  { context, path }: WriteDestination,
): Promise<StorageError | undefined> {
  const errno = errnoOf(thrown);
  const failure = {
    operation: context.operation,
    key: context.key,
    attempts: 1,
    providerCode: errno,
    cause: thrown,
  };

  if (refusesHardLinks(thrown)) {
    return fsError(context.root, {
      ...failure,
      code: "ProviderError",
      message: 'The file system holds no hard links, which `onlyIf: "absent"` is held through',
      retryable: false,
    });
  }

  if (errno !== "EEXIST") return undefined;

  // A name that holds no object, which answers `exists` with `false`, is no precondition
  // failing: a caller reading the key back would meet `NotFound` and go around again.
  if (!(await heldByObject(context, path))) {
    return fsError(context.root, {
      ...failure,
      code: "InvalidRequest",
      message: `The key ${JSON.stringify(context.key)} names no object, and something else holds its name`,
    });
  }

  return fsError(context.root, {
    ...failure,
    code: "PreconditionFailed",
    message: `The key ${JSON.stringify(context.key)} holds an object`,
  });
}

/**
 * Whether an object held the name `link` met: a file, or a link resolving to one below the
 * root (spec 6).
 */
async function heldByObject(context: FsAccessContext, path: string): Promise<boolean> {
  const held = await lookUp(context, async () => await lstat(path));

  // Another caller removed what `link` met before it could be looked at. It held the name
  // as the write was to take effect, which is the precondition failing.
  if (held === undefined) return true;

  return (await describe(context, path))?.isFile() === true;
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
