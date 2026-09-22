import type { ListOptions, ObjectListing } from "@stowage/core";

import { assert, assertDate, assertSameBytes, expectStorageError } from "../assertions.ts";
import type { ConformanceCaseSource } from "../case.ts";
import { serializeError } from "../result.ts";
import type { ConformanceContext } from "../target.ts";
import { patternOf } from "./bytes.ts";
import { prefixFor } from "./keys.ts";
import {
  assertNamesEachOnce,
  collectEntries,
  keysBelow,
  pastOneThousand,
  putEach,
} from "./objects.ts";

const utf8 = new TextEncoder();

/** The page size spec 4.6 bounds a page at, which two page sizes sit on either side of. */
const pageSizeLimit = 1000;

interface NormalForm {
  /** How the case names the form, which is what a failing one reports. */
  readonly form: string;
  readonly name: string;
}

/**
 * One name in the two Unicode normal forms spec 4.8 leaves as two keys or as one. The
 * forms are built from their code points rather than written down, because two source
 * strings that differ in nothing a reader sees are two a tool folds into one.
 */
const normalForms: readonly NormalForm[] = [
  { form: "NFC", name: `caf${String.fromCodePoint(0xe9)}` },
  { form: "NFD", name: `cafe${String.fromCodePoint(0x301)}` },
];

export const listCases: readonly ConformanceCaseSource[] = [
  {
    name: "list/nothing",
    requires: [],
    cost: "fast",
    async run(ctx) {
      const prefix = prefixFor(ctx, "list/nothing");
      const iterated = await collectEntries(ctx.storage.list({ prefix }));

      assert(
        iterated.length === 0,
        `A listing below a prefix holding nothing yields ${iterated.length} entries`,
      );

      const page = await ctx.storage.list({ prefix }).page();

      assert(
        page.objects.length === 0,
        `A page below a prefix holding nothing holds ${page.objects.length} objects`,
      );
      assert(
        page.prefixes.length === 0,
        `A page below a prefix holding nothing holds ${page.prefixes.length} pseudo-directories`,
      );
      assert(
        page.cursor === undefined,
        "A page below a prefix holding nothing carries a cursor, so the listing is not complete",
      );
    },
  },
  {
    name: "list/every-object-once",
    requires: [],
    cost: "fast",
    async run(ctx) {
      const prefix = prefixFor(ctx, "list/every-object-once");
      const keys = keysBelow(prefix, 25);

      await putEach(ctx, keys, patternOf(8));

      const iterated = await collectEntries(ctx.storage.list({ prefix }));

      assertNamesEachOnce(
        iterated.map((entry) => entry.key),
        keys,
        "The iteration below the prefix",
      );
    },
  },
  {
    name: "list/entry-shape",
    requires: [],
    cost: "fast",
    async run(ctx) {
      const prefix = prefixFor(ctx, "list/entry-shape");
      // Every object is a different length, so an entry carrying another object's size
      // shows up rather than agreeing with the one it names by accident.
      const sizes = new Map(keysBelow(prefix, 3).map((key, index) => [key, 16 * (index + 1)]));

      await Promise.all(
        [...sizes].map(async ([key, size]) => void (await ctx.storage.put(key, patternOf(size)))),
      );

      const iterated = await collectEntries(ctx.storage.list({ prefix }));

      assertNamesEachOnce(
        iterated.map((entry) => entry.key),
        [...sizes.keys()],
        "The iteration below the prefix",
      );

      for (const entry of iterated) {
        const written = sizes.get(entry.key);

        assert(
          entry.size === written,
          `The entry for ${JSON.stringify(entry.key)} reports ${entry.size} bytes and not the ${written} that were written`,
        );
        assertDate(entry.lastModified, `The last modification of ${JSON.stringify(entry.key)}`);
      }
    },
  },
  {
    name: "list/pages-and-cursor",
    requires: [],
    cost: "fast",
    async run(ctx) {
      const prefix = prefixFor(ctx, "list/pages-and-cursor");
      const keys = keysBelow(prefix, 5);

      await putEach(ctx, keys, patternOf(8));

      const held: string[] = [];
      const counts: number[] = [];
      let cursor: string | undefined;

      for (let page = 1; page <= 3; page += 1) {
        // Spec 4.6 has a cursor continue the listing from a `list` call of its own, which
        // is what a caller paging from another process holds and all a page promises.
        // oxlint-disable-next-line no-await-in-loop -- the next page needs this one's cursor
        const read = await ctx.storage.list({ prefix, pageSize: 2, cursor }).page();

        held.push(...read.objects.map((entry) => entry.key));
        counts.push(read.objects.length);
        cursor = read.cursor;

        if (page === 3) {
          assert(
            cursor === undefined,
            "Page 3 of 3 carries a cursor, so the listing continues after its final object",
          );
        } else {
          assert(
            cursor !== undefined,
            `Page ${page} of 3 carries no cursor, so the listing ends before its objects do`,
          );
        }
      }

      assert(
        counts.join(", ") === "2, 2, 1",
        `Pages of 2 over 5 objects hold ${counts.join(", ")} objects`,
      );
      assertNamesEachOnce(held, keys, "The three pages together");
    },
  },
  {
    name: "list/delimiter",
    requires: [],
    cost: "fast",
    async run(ctx) {
      const prefix = prefixFor(ctx, "list/delimiter");
      const atTheLevel = [`${prefix}a.txt`, `${prefix}b.txt`];
      const below = [`${prefix}one/x.txt`, `${prefix}one/y.txt`, `${prefix}two/x.txt`];

      await putEach(ctx, [...atTheLevel, ...below], patternOf(8));

      const page = await ctx.storage.list({ prefix, delimiter: "/" }).page();

      assertNamesEachOnce(
        page.objects.map((entry) => entry.key),
        atTheLevel,
        "The objects of a page with a delimiter",
      );
      assertNamesEachOnce(
        page.prefixes,
        [`${prefix}one/`, `${prefix}two/`],
        "The pseudo-directories of a page with a delimiter",
      );

      // Spec 4.6: a delimiter shapes a page, and the iteration yields the objects at the
      // level without the pseudo-directories reaching it at all.
      const iterated = await collectEntries(ctx.storage.list({ prefix, delimiter: "/" }));

      assertNamesEachOnce(
        iterated.map((entry) => entry.key),
        atTheLevel,
        "The iteration with a delimiter",
      );
    },
  },
  {
    name: "list/prefix-mid-segment",
    requires: [],
    cost: "fast",
    async run(ctx) {
      const prefix = prefixFor(ctx, "list/prefix-mid-segment");
      const matching = [`${prefix}report-1.txt`, `${prefix}report-2.txt`];
      const beside = `${prefix}receipt.txt`;

      await putEach(ctx, [...matching, beside], patternOf(8));

      const iterated = await collectEntries(ctx.storage.list({ prefix: `${prefix}report-` }));

      assertNamesEachOnce(
        iterated.map((entry) => entry.key),
        matching,
        "The iteration below a prefix ending inside a segment",
      );
    },
  },
  {
    name: "list/lazy",
    requires: [],
    cost: "fast",
    async run(ctx) {
      const prefix = prefixFor(ctx, "list/lazy");
      // Spec 4.6 has `list` perform no request until the listing is read, which an
      // object written between the two makes observable: a listing that fetched where it
      // was built names nothing, and one that fetches where it is read names the object.
      const listing = listWithoutReading(ctx, { prefix });
      const key = `${prefix}written-after-the-listing-was-built`;

      await ctx.storage.put(key, patternOf(8));

      const page = await listing.page();

      assertNamesEachOnce(
        page.objects.map((entry) => entry.key),
        [key],
        "The first page of a listing built before the write",
      );

      // The other side of the same promise: an option no listing can be built on reaches
      // the caller from `page()` rather than from the `list` call that carried it.
      const refused = listWithoutReading(ctx, { prefix, pageSize: 0 });

      await expectStorageError(() => refused.page(), { code: "InvalidOption" });
    },
  },
  {
    name: "list/page-size-bounds",
    requires: [],
    cost: "fast",
    async run(ctx) {
      const prefix = prefixFor(ctx, "list/page-size-bounds");

      await Promise.all(
        [0, pageSizeLimit + 1].map(async (pageSize) => {
          const refusal = await expectStorageError(
            async () => await listWithoutReading(ctx, { prefix, pageSize }).page(),
            { code: "InvalidOption" },
            `a page size of ${pageSize}`,
          );

          assertNamesTheOption(refusal.message, "pageSize");
        }),
      );
    },
  },
  {
    name: "list/invalid-cursor",
    requires: [],
    cost: "fast",
    async run(ctx) {
      const prefix = prefixFor(ctx, "list/invalid-cursor");
      const cursor = "this-is-no-cursor-the-storage-handed-out";
      const refusal = await expectStorageError(
        async () => await listWithoutReading(ctx, { prefix, cursor }).page(),
        { code: "InvalidOption" },
      );

      assertNamesTheOption(refusal.message, "cursor");
    },
  },
  {
    name: "list/invalid-delimiter",
    requires: [],
    cost: "fast",
    async run(ctx) {
      const prefix = prefixFor(ctx, "list/invalid-delimiter");

      await expectStorageError(
        async () => await listWithoutReading(ctx, { prefix, delimiter: "" }).page(),
        { code: "InvalidOption" },
      );
    },
  },
  {
    name: "list/past-one-thousand",
    requires: [],
    cost: "slow",
    async run(ctx) {
      const prefix = prefixFor(ctx, "list/past-one-thousand");
      const keys = keysBelow(prefix, pastOneThousand);

      await putEach(ctx, keys, patternOf(8));

      const iterated = await collectEntries(ctx.storage.list({ prefix }));

      assertNamesEachOnce(
        iterated.map((entry) => entry.key),
        keys,
        "The iteration below the prefix",
      );

      const page = await ctx.storage.list({ prefix }).page();

      assert(
        page.objects.length <= pageSizeLimit,
        `One page at the default size holds ${page.objects.length} objects`,
      );
      assert(
        page.cursor !== undefined,
        `A page of ${page.objects.length} objects out of ${pastOneThousand} carries no cursor`,
      );
    },
  },
  {
    name: "list/key-bytes",
    requires: ["keyBytesPreserved"],
    cost: "fast",
    async run(ctx) {
      const prefix = prefixFor(ctx, "list/key-bytes");

      // The body names the form, so that two keys the storage folded into one show up as
      // one object holding the other form's body rather than as a key that merely reads.
      await Promise.all(
        normalForms.map(
          async ({ form, name }) =>
            void (await ctx.storage.put(`${prefix}${name}`, utf8.encode(form))),
        ),
      );

      const iterated = await collectEntries(ctx.storage.list({ prefix }));

      assertNamesEachOnce(
        iterated.map((entry) => entry.key),
        normalForms.map(({ name }) => `${prefix}${name}`),
        "The iteration below the prefix",
      );

      await Promise.all(
        normalForms.map(async ({ form, name }) => {
          const stored = await ctx.storage.get(`${prefix}${name}`);

          assertSameBytes(
            await stored.bytes(),
            utf8.encode(form),
            `the object under the ${form} key`,
          );
        }),
      );
    },
    async runWithout(ctx) {
      // A storage that does not declare the capability may hold the two forms as one
      // object, so each goes below a prefix of its own and the case reads the key back.
      await Promise.all(
        normalForms.map(async ({ form, name }) => {
          const prefix = `${prefixFor(ctx, "list/key-bytes")}${form}/`;
          const key = `${prefix}${name}`;

          await ctx.storage.put(key, patternOf(8));

          const iterated = await collectEntries(ctx.storage.list({ prefix }));
          const listed = iterated[0]?.key;

          assert(
            iterated.length === 1,
            `The listing below the ${form} prefix yields ${iterated.length} entries for the one object the case wrote`,
          );
          assert(
            listed?.normalize() === key.normalize(),
            `The listing names the ${form} key as ${JSON.stringify(listed)}, which is no Unicode equivalent of ${JSON.stringify(key)}`,
          );
        }),
      );
    },
  },
];

/**
 * A listing built but not read. Spec 4.6 has `list` perform no request until then, so it
 * reports nothing — not even an option it is going to refuse. A throw here is that
 * promise broken rather than the refusal the case is after, and worth saying apart.
 */
function listWithoutReading(ctx: ConformanceContext, options: ListOptions): ObjectListing {
  try {
    return ctx.storage.list(options);
  } catch (thrown) {
    throw new Error(
      `\`list\` refused ${JSON.stringify(options)} before the listing was read: ${serializeError(thrown).message}`,
      { cause: thrown },
    );
  }
}

function assertNamesTheOption(message: string, option: string): void {
  assert(
    message.includes(option),
    `The message ${JSON.stringify(message)} does not name the option \`${option}\``,
  );
}
