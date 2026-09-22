import { mkdir, realpath } from "node:fs/promises";
import { basename, dirname, join, sep } from "node:path";

import type { StorageError } from "@stowage/core";

import { errnoOf, type FsAccess, fsErrorFrom, isAbsence } from "./errno.ts";
import { fsError } from "./storage-error.ts";

/** One key of one operation, against the root both are resolved below. */
export interface FsAccessContext {
  readonly root: string;
  readonly realRoot: string;
  readonly key: string;
  readonly operation: string;
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

/** The key names nothing this storage holds, which is what a read of it answers. */
export function absent(context: FsAccessContext): StorageError {
  return fsError(context.root, {
    code: "NotFound",
    message: `No object under the key ${JSON.stringify(context.key)}`,
    operation: context.operation,
    key: context.key,
    attempts: 1,
  });
}

/**
 * The real path of the file the key names. Spec 6 has every access resolve it and answer
 * `NotFound` where it lies outside the root, so a symbolic link leaving the root behaves
 * as an absent object rather than as a way out of the storage.
 */
export async function resolveObject(context: FsAccessContext): Promise<string> {
  const path = pathOf(context.realRoot, context.key);

  if (path === undefined) throw absent(context);

  let resolved: string;

  try {
    resolved = await realpath(path);
  } catch (thrown) {
    throw fsErrorFrom(thrown, { ...context, access: "read" });
  }

  if (!within(context.realRoot, resolved)) throw absent(context);

  return resolved;
}

/**
 * The path a write lands under, with the directories above it in place. The directory is
 * resolved after it was created, because a link leaving the root is a path this storage
 * does not write to either.
 */
export async function prepareWrite(context: FsAccessContext): Promise<string> {
  const path = pathOf(context.realRoot, context.key);

  // A writable key ends in no slash (spec 4.8), so the key names a file at this point.
  if (path === undefined) throw absent(context);

  await makeDirectory(dirname(path), context);

  let directory: string;

  try {
    directory = await realpath(dirname(path));
  } catch (thrown) {
    throw fsErrorFrom(thrown, { ...context, access: "write" });
  }

  if (!within(context.realRoot, directory)) throw absent(context);

  const target = join(directory, basename(path));

  // A link at the key leaves the root as much as one on the way to it, so the write is
  // refused rather than following it or replacing it (spec 6).
  if (!(await resolvesWithin(context, target))) throw absent(context);

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

async function makeDirectory(directory: string, context: FsAccessContext): Promise<void> {
  try {
    await mkdir(directory, { recursive: true });
  } catch (thrown) {
    // A regular file on the way to the directory arrives as `ENOTDIR` where it lies
    // above the last segment and as `EEXIST` where it is that segment itself. Spec 6
    // leaves a write over a file with `InvalidRequest`, which the table carries for the
    // first of the two alone.
    if (errnoOf(thrown) !== "EEXIST") throw fsErrorFrom(thrown, { ...context, access: "write" });

    throw fsError(context.root, {
      code: "InvalidRequest",
      message: `The key ${JSON.stringify(context.key)} lies below a path that is no directory`,
      operation: context.operation,
      key: context.key,
      attempts: 1,
      providerCode: "EEXIST",
      cause: thrown,
    });
  }
}
