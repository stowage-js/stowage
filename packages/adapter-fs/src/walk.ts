import type { Stats } from "node:fs";
import { lstat, readdir, realpath, stat } from "node:fs/promises";
import { join } from "node:path";

import type { ObjectEntry } from "@stowage/core";

import { fsErrorFrom, isAbsence } from "./errno.ts";
import { type FsRootContext, within } from "./paths.ts";
import { fsError } from "./storage-error.ts";
import { isTemporaryName } from "./temporary.ts";

/** One name of a level, or the bytes of one that is no UTF-8 and so names no key. */
type LevelEntry =
  | { readonly name: string; readonly directory: boolean }
  | { readonly bytes: Uint8Array };

const utf8 = new TextEncoder();
const strictUtf8 = new TextDecoder("utf-8", { fatal: true });

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

  await collect(
    { context, entries, prefix: utf8.encode(prefix) },
    join(context.realRoot, ...directory.split("/")),
    directory,
  );

  return entries.filter((entry) => entry.key.startsWith(prefix)).toSorted(byKey);
}

interface Walk {
  readonly context: FsRootContext;
  readonly entries: ObjectEntry[];
  /** The prefix as bytes, which is the one form a name that is no UTF-8 compares in. */
  readonly prefix: Uint8Array;
}

async function collect(walk: Walk, directory: string, keyPrefix: string): Promise<void> {
  const { context, entries } = walk;
  let resolved: string;
  let held: readonly LevelEntry[];

  try {
    resolved = await realpath(directory);

    if (!within(context.realRoot, resolved)) return;

    held = await entriesOf(resolved);
  } catch (thrown) {
    // A level that is not there holds no object, which is what a prefix below nothing
    // amounts to. The root itself is resolved before the walk begins.
    if (isAbsence(thrown)) return;

    throw failure(context, thrown);
  }

  for (const entry of held) {
    if ("bytes" in entry) {
      refuseUndecodableName(walk, keyPrefix, entry.bytes);
      continue;
    }

    const path = join(resolved, entry.name);
    const key = `${keyPrefix}${entry.name}`;

    if (entry.directory) {
      // oxlint-disable-next-line no-await-in-loop -- one tree, walked level by level
      await collect(walk, path, `${key}/`);
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
 * The names of one level. The runtime decodes a name that is no UTF-8 with U+FFFD in
 * place of what it cannot read, so a level holding that character reads its names again
 * as bytes to tell such a name from one that holds U+FFFD as written.
 */
async function entriesOf(directory: string): Promise<readonly LevelEntry[]> {
  const held = await readdir(directory, { withFileTypes: true });

  if (!held.some((entry) => entry.name.includes("\uFFFD"))) {
    return held.map((entry) => ({ name: entry.name, directory: entry.isDirectory() }));
  }

  // Bun hands out no `Dirent` for names read as bytes, so the type comes from `lstat`,
  // which reads a link as a link, as a `Dirent` does.
  const names = await readdir(directory, { encoding: "buffer" });
  const entries: LevelEntry[] = [];

  for (const bytes of names) {
    const name = utf8NameOf(bytes);

    if (name === undefined) {
      entries.push({ bytes });
      continue;
    }

    try {
      // oxlint-disable-next-line no-await-in-loop -- keep fallback stats bounded
      entries.push({ name, directory: (await lstat(join(directory, name))).isDirectory() });
    } catch (thrown) {
      // Removed by another writer since the level was read, as `describe` passes over.
      if (isAbsence(thrown)) continue;

      throw thrown;
    }
  }

  return entries;
}

function utf8NameOf(bytes: Uint8Array): string | undefined {
  try {
    return strictUtf8.decode(bytes);
  } catch {
    return undefined;
  }
}

/**
 * A name that is no UTF-8 has no key, and a key with U+FFFD in its place would reach
 * another object or none. Passing over it would let a move of the prefix lose the file
 * in silence, so a listing it falls below fails as one whose entry arrived without a key
 * (spec 4.6); a listing beside it goes on.
 */
function refuseUndecodableName(walk: Walk, keyPrefix: string, bytes: Uint8Array): void {
  const path = new Uint8Array([...utf8.encode(keyPrefix), ...bytes]);

  if (!startsWith(path, walk.prefix)) return;

  throw fsError(walk.context.root, {
    code: "ProviderError",
    message: `The name ${escapedBytesOf(path)} is no UTF-8, so no key names it`,
    operation: walk.context.operation,
    attempts: 1,
    retryable: false,
  });
}

function startsWith(bytes: Uint8Array, start: Uint8Array): boolean {
  return start.length <= bytes.length && start.every((byte, index) => bytes[index] === byte);
}

function escapedBytesOf(bytes: Uint8Array): string {
  const escaped = Array.from(bytes, (byte) =>
    standsAsItIs(byte)
      ? String.fromCharCode(byte)
      : `\\x${byte.toString(16).toUpperCase().padStart(2, "0")}`,
  );

  return `"${escaped.join("")}"`;
}

/** Printable ASCII but for the quote and the backslash, which would read as an escape. */
function standsAsItIs(byte: number): boolean {
  return byte >= 0x20 && byte <= 0x7e && byte !== 0x22 && byte !== 0x5c;
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
