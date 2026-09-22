import type { Dirent, Stats } from "node:fs";
import { readdir, realpath, stat } from "node:fs/promises";
import { join } from "node:path";

import type { ObjectEntry } from "@stowage/core";

import { fsErrorFrom, isAbsence } from "./errno.ts";
import { within } from "./paths.ts";

/** One walk of the tree below a root, which carries no key of its own. */
export interface WalkContext {
  readonly root: string;
  readonly realRoot: string;
  readonly operation: string;
}

/** The name a write in flight holds: a file of this adapter, and no object of anyone. */
const temporaryName = /^\.stowage-[\da-f-]{36}\.tmp$/;

/**
 * Every object below the prefix, sorted by key. A listing pages through one order, so
 * the snapshot it reads is sorted; the order itself is not promised (spec 4.6).
 */
export async function walkObjects(
  context: WalkContext,
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
  context: WalkContext,
  entries: ObjectEntry[],
  directory: string,
  keyPrefix: string,
): Promise<void> {
  let held: readonly Dirent[];

  try {
    held = await readdir(directory, { withFileTypes: true });
  } catch (thrown) {
    // A level that is not there holds no object, which is what a prefix below nothing
    // amounts to. The root itself is resolved before the walk begins.
    if (isAbsence(thrown)) return;

    throw fsErrorFrom(thrown, {
      root: context.root,
      operation: context.operation,
      access: "read",
    });
  }

  for (const entry of held) {
    const path = join(directory, entry.name);
    const key = `${keyPrefix}${entry.name}`;

    if (entry.isDirectory()) {
      // oxlint-disable-next-line no-await-in-loop -- one tree, walked level by level
      await collect(context, entries, path, `${key}/`);
      continue;
    }

    if (temporaryName.test(entry.name)) continue;

    // oxlint-disable-next-line no-await-in-loop -- one tree, walked in order
    const described = await describe(context, entry.isSymbolicLink() ? path : undefined, path);

    if (described !== undefined)
      entries.push({ key, size: described.size, lastModified: described.mtime });
  }
}

/**
 * What the entry holds, or `undefined` for everything that is no object: a link leaving
 * the root, a link to a directory, a socket, and a file another writer removed between
 * the listing of the level and the reading of it.
 */
async function describe(
  context: WalkContext,
  link: string | undefined,
  path: string,
): Promise<Stats | undefined> {
  try {
    if (link !== undefined && !within(context.realRoot, await realpath(link))) return undefined;

    const described = await stat(path);

    return described.isFile() ? described : undefined;
  } catch (thrown) {
    if (isAbsence(thrown)) return undefined;

    throw fsErrorFrom(thrown, {
      root: context.root,
      operation: context.operation,
      access: "read",
    });
  }
}

function byKey(one: ObjectEntry, other: ObjectEntry): number {
  return one.key < other.key ? -1 : one.key > other.key ? 1 : 0;
}
