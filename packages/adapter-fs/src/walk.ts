import type { Dirent, Stats } from "node:fs";
import { readdir, realpath, stat } from "node:fs/promises";
import { join } from "node:path";

import type { ObjectEntry } from "@stowage/core";

import { fsErrorFrom, isAbsence } from "./errno.ts";
import { type FsRootContext, within } from "./paths.ts";
import { isTemporaryName } from "./temporary.ts";

/**
 * Every object below the prefix, sorted by key. A listing pages through one order, so
 * the snapshot it reads is sorted; the order itself is not promised (spec 4.6).
 */
export async function walkObjects(
  context: FsRootContext,
  prefix: string,
): Promise<readonly ObjectEntry[]> {
  const entries: ObjectEntry[] = [];
  // A prefix may end in the middle of a segment (spec 4.8), so the walk starts at the
  // last directory the prefix names and what is left of it filters what the walk found.
  const directory = prefix.slice(0, prefix.lastIndexOf("/") + 1);

  await collect(context, entries, join(context.realRoot, ...directory.split("/")), directory);

  return entries.filter((entry) => entry.key.startsWith(prefix)).toSorted(byKey);
}

async function collect(
  context: FsRootContext,
  entries: ObjectEntry[],
  directory: string,
  keyPrefix: string,
): Promise<void> {
  let resolved: string;
  let held: readonly Dirent[];

  try {
    resolved = await realpath(directory);

    if (!within(context.realRoot, resolved)) return;

    held = await readdir(resolved, { withFileTypes: true });
  } catch (thrown) {
    // A level that is not there holds no object, which is what a prefix below nothing
    // amounts to. The root itself is resolved before the walk begins.
    if (isAbsence(thrown)) return;

    throw failure(context, thrown);
  }

  for (const entry of held) {
    const path = join(resolved, entry.name);
    const key = `${keyPrefix}${entry.name}`;

    if (entry.isDirectory()) {
      // oxlint-disable-next-line no-await-in-loop -- one tree, walked level by level
      await collect(context, entries, path, `${key}/`);
      continue;
    }

    if (isTemporaryName(entry.name)) continue;

    // oxlint-disable-next-line no-await-in-loop -- one tree, walked in order
    const described = await describe(context, path);

    if (described !== undefined)
      entries.push({ key, size: described.size, lastModified: described.mtime });
  }
}

/**
 * What the entry holds, or `undefined` for everything that is no object: a link leaving
 * the root, a link to a directory, a socket, and a file another writer removed between
 * the listing of the level and the reading of it.
 */
async function describe(context: FsRootContext, path: string): Promise<Stats | undefined> {
  try {
    const resolved = await realpath(path);

    if (!within(context.realRoot, resolved)) return undefined;

    const described = await stat(resolved);

    return described.isFile() ? described : undefined;
  } catch (thrown) {
    if (isAbsence(thrown)) return undefined;

    throw failure(context, thrown);
  }
}

// A walk names no key: what it reads is the tree, and a failure of it concerns the
// listing rather than one object (spec 4.10).
function failure(context: FsRootContext, thrown: unknown): unknown {
  return fsErrorFrom(thrown, {
    root: context.root,
    operation: context.operation,
    access: "read",
  });
}

function byKey(one: ObjectEntry, other: ObjectEntry): number {
  return one.key < other.key ? -1 : one.key > other.key ? 1 : 0;
}
