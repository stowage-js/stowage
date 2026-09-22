import type { ObjectStat } from "@stowage/core";

import { assert, assertSameBytes, expectStorageError } from "../assertions.ts";
import type { ConformanceCaseSource } from "../case.ts";
import type { ConformanceContext } from "../target.ts";
import { prefixFor } from "./keys.ts";

const utf8 = new TextEncoder();

/** Spec 6 has `adapter-fs` derive the content type from the key, so the two agree here. */
const contentType = "text/plain";

interface WrittenObject {
  readonly key: string;
  readonly body: Uint8Array;
}

export const copyAndMoveCases: readonly ConformanceCaseSource[] = [
  {
    name: "copy/round-trip",
    requires: [],
    cost: "fast",
    async run(ctx) {
      const prefix = prefixFor(ctx, "copy/round-trip");
      const source = await write(ctx, `${prefix}source.txt`, "the body to copy");
      const to = `${prefix}destination.txt`;
      const written = await ctx.storage.copy(source.key, to);

      assertNames(written, to, "`copy`");
      await assertHolds(ctx, to, source.body, "The destination");
      // Spec 4.11 leaves `from` where it is, which is what tells a copy from a move.
      await assertHolds(ctx, source.key, source.body, "The source after the copy");
    },
  },
  {
    name: "copy/overwrites",
    requires: [],
    cost: "fast",
    async run(ctx) {
      const prefix = prefixFor(ctx, "copy/overwrites");
      const source = await write(ctx, `${prefix}source.txt`, "the body that replaces");
      const destination = await write(ctx, `${prefix}destination.txt`, "the body that is replaced");

      await ctx.storage.copy(source.key, destination.key);
      await assertHolds(ctx, destination.key, source.body, "The destination that was there");
    },
  },
  {
    name: "copy/missing-source",
    requires: [],
    cost: "fast",
    async run(ctx) {
      const prefix = prefixFor(ctx, "copy/missing-source");
      const to = `${prefix}destination.txt`;

      await expectStorageError(() => ctx.storage.copy(`${prefix}absent.txt`, to), {
        code: "NotFound",
      });
      await assertAbsent(ctx, to, "a copy whose source is not there");
    },
  },
  {
    name: "copy/onto-itself",
    requires: [],
    cost: "fast",
    async run(ctx) {
      const prefix = prefixFor(ctx, "copy/onto-itself");
      const source = await write(ctx, `${prefix}object.txt`, "the body that stays");

      await expectStorageError(() => ctx.storage.copy(source.key, source.key), {
        code: "InvalidRequest",
        attempts: 0,
      });
      await assertHolds(ctx, source.key, source.body, "The object a copy onto itself refused");
    },
  },
  {
    name: "copy/invalid-keys",
    requires: [],
    cost: "fast",
    async run(ctx) {
      const prefix = prefixFor(ctx, "copy/invalid-keys");
      const source = await write(ctx, `${prefix}source.txt`, "the body that stays");
      const to = `${prefix}destination.txt`;

      // Spec 4.8 has `copy` check both keys before it acts on either, so each refusal
      // leaves the source where it is and creates nothing under the valid key beside it.
      await expectStorageError(
        () => ctx.storage.copy(source.key, `${prefix}destination/`),
        { code: "InvalidKey" },
        "a destination ending in a slash",
      );
      await expectStorageError(
        () => ctx.storage.copy(`${prefix}../source.txt`, to),
        { code: "InvalidKey" },
        "a source holding a `..` segment",
      );

      await assertHolds(ctx, source.key, source.body, "The source a refused copy left");
      await assertAbsent(ctx, to, "a copy whose source key was refused");
    },
  },
  {
    name: "copy/user-metadata",
    requires: ["userMetadata"],
    cost: "fast",
    async run(ctx) {
      const prefix = prefixFor(ctx, "copy/user-metadata");
      const from = `${prefix}source.txt`;
      const to = `${prefix}destination.txt`;

      await ctx.storage.put(from, "the body to copy", {
        contentType,
        userMetadata: { "Written-By": "stowage" },
      });
      await ctx.storage.copy(from, to);

      const described = await ctx.storage.stat(to);
      const held = new Map(
        Object.entries(described.userMetadata).map(([name, value]) => [name.toLowerCase(), value]),
      );

      assert(
        held.get("written-by") === "stowage",
        `The destination carries the user metadata ${JSON.stringify(described.userMetadata)} and not the source's`,
      );
    },
    async runWithout(ctx) {
      const prefix = prefixFor(ctx, "copy/user-metadata");
      const from = `${prefix}source.txt`;
      const to = `${prefix}destination.txt`;

      // Spec 4.9 has a storage declaring no `userMetadata` read back none, so there is
      // nothing for the copy to carry and the copy itself is one like any other.
      await ctx.storage.put(from, "the body to copy", { contentType });
      await ctx.storage.copy(from, to);

      const described = await ctx.storage.stat(to);

      assert(
        Object.keys(described.userMetadata).length === 0,
        `The destination reports the user metadata ${JSON.stringify(described.userMetadata)} on a storage that holds none`,
      );
    },
  },
  {
    name: "move/round-trip",
    requires: [],
    cost: "fast",
    async run(ctx) {
      const prefix = prefixFor(ctx, "move/round-trip");
      const source = await write(ctx, `${prefix}source.txt`, "the body to move");
      const to = `${prefix}destination.txt`;
      const written = await ctx.storage.move(source.key, to);

      assertNames(written, to, "`move`");
      await assertHolds(ctx, to, source.body, "The destination");
      await assertAbsent(ctx, source.key, "a move");
    },
  },
  {
    name: "move/missing-source",
    requires: [],
    cost: "fast",
    async run(ctx) {
      const prefix = prefixFor(ctx, "move/missing-source");
      const to = `${prefix}destination.txt`;

      await expectStorageError(() => ctx.storage.move(`${prefix}absent.txt`, to), {
        code: "NotFound",
        operation: "move",
      });
      await assertAbsent(ctx, to, "a move whose source is not there");
    },
  },
];

async function write(ctx: ConformanceContext, key: string, text: string): Promise<WrittenObject> {
  await ctx.storage.put(key, text, { contentType });

  return { key, body: utf8.encode(text) };
}

// Spec 4.11 has both operations resolve with the description of the destination, which
// is what a caller goes on rather than looking the object up again.
function assertNames(written: ObjectStat, to: string, what: string): void {
  assert(
    written.key === to,
    `${what} reports the key ${JSON.stringify(written.key)} and not the destination ${JSON.stringify(to)}`,
  );
}

async function assertHolds(
  ctx: ConformanceContext,
  key: string,
  body: Uint8Array,
  what: string,
): Promise<void> {
  const stored = await ctx.storage.get(key);

  assert(
    stored.stat.contentType === contentType,
    `${what} reports the content type ${JSON.stringify(stored.stat.contentType)} and not ${JSON.stringify(contentType)}`,
  );
  assertSameBytes(await stored.bytes(), body, `The body under ${JSON.stringify(key)}`);
}

async function assertAbsent(ctx: ConformanceContext, key: string, after: string): Promise<void> {
  assert(
    !(await ctx.storage.exists(key)),
    `The object under ${JSON.stringify(key)} is there after ${after}`,
  );
}
