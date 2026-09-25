import type { ObjectEntry, ObjectListing } from "@stowage/core";

import { assert } from "../assertions.ts";
import type { ConformanceContext } from "../target.ts";

/**
 * What a case writes where it reads the content type back, under a key ending in `.txt`:
 * spec 6 has `adapter-fs` derive the type from the key rather than store the one it was
 * given, so the two have to agree.
 */
export const textContentType: string = "text/plain";

/**
 * How many writes a case keeps in flight. The cases past one thousand objects write more
 * than a provider answers at once: a thousand requests in flight come back as throttling
 * rather than as the objects the case is about.
 */
const inFlight = 32;

/**
 * What the `slow` cases of spec 9.5 write: one past the thousand objects a provider
 * answers a listing with and takes in a delete at the most, so that the case reaches
 * past the one page and the one batch rather than filling them.
 */
export const pastOneThousand = 1001;

/** The keys of `count` objects below `prefix`, numbered so that a failure names one. */
export function keysBelow(prefix: string, count: number): readonly string[] {
  const width = String(count - 1).length;

  return Array.from(
    { length: count },
    (_, index) => `${prefix}${String(index).padStart(width, "0")}`,
  );
}

export async function putEach(
  ctx: ConformanceContext,
  keys: readonly string[],
  body: Uint8Array,
): Promise<void> {
  for (let start = 0; start < keys.length; start += inFlight) {
    const batch = keys.slice(start, start + inFlight);

    // oxlint-disable-next-line no-await-in-loop -- what bounds the writes in flight
    await Promise.all(batch.map(async (key) => void (await ctx.storage.put(key, body))));
  }
}

export async function collectEntries(listing: ObjectListing): Promise<readonly ObjectEntry[]> {
  const entries: ObjectEntry[] = [];

  for await (const entry of listing) entries.push(entry);

  return entries;
}

/**
 * The keys a listing named, against the keys the case wrote. Spec 4.6 promises every
 * object below the prefix once and no order, so the two sides meet as sets.
 */
export function assertNamesEachOnce(
  held: readonly string[],
  expected: readonly string[],
  what: string,
): void {
  const once = new Set(held);

  assert(
    once.size === held.length,
    `${what} names ${held.length} keys, ${once.size} of them distinct`,
  );

  for (const key of expected) {
    assert(once.has(key), `${what} names no ${JSON.stringify(key)}`);
  }

  const beyond = [...once].filter((key) => !expected.includes(key));

  assert(
    beyond.length === 0,
    `${what} names ${beyond.map((key) => JSON.stringify(key)).join(", ")} beyond what the case wrote`,
  );
}

/** That nothing is left below the prefix, which is how a deletion of many keys is read. */
export async function assertNothingBelow(ctx: ConformanceContext, prefix: string): Promise<void> {
  const left = await collectEntries(ctx.storage.list({ prefix }));

  assert(
    left.length === 0,
    `${left.length} objects are left below ${JSON.stringify(prefix)}, the first of them ${JSON.stringify(left[0]?.key)}`,
  );
}
