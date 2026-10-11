import type { ObjectEntry } from "@stowage/core";

import { assert, assertDate, assertSameBytes, expectStorageError } from "../assertions.ts";
import type { ConformanceCaseSource } from "../case.ts";
import { patternOf } from "./bytes.ts";
import { keyFor, prefixFor } from "./keys.ts";
import { collectEntries } from "./objects.ts";

const utf8 = new TextEncoder();

/** What spec 4.4 allows between the time the provider reported and the clock reading it. */
const clockTolerance = 60_000;

export const statCases: readonly ConformanceCaseSource[] = [
  {
    name: "stat/describes-object",
    requires: [],
    cost: "fast",
    async run(ctx) {
      const key = keyFor(ctx, "stat/describes-object", "object.txt");
      const body = "a body to describe";
      const size = utf8.encode(body).byteLength;

      await ctx.storage.put(key, body, { contentType: "text/plain" });

      const described = await ctx.storage.stat(key);

      assert(
        described.key === key,
        `\`stat\` reports the key ${JSON.stringify(described.key)} for ${JSON.stringify(key)}`,
      );
      assert(described.size === size, `\`stat\` reports ${described.size} bytes and not ${size}`);
      assert(
        described.contentType === "text/plain",
        `\`stat\` reports the content type ${JSON.stringify(described.contentType)}`,
      );
      assertWrittenJustNow(described.lastModified);
      // A target may be written in JavaScript, where the declared type of a field
      // promises nothing about what the storage carries.
      assert(
        typeof described.userMetadata === "object" && described.userMetadata !== null,
        `\`stat\` reports the user metadata as ${JSON.stringify(described.userMetadata)}`,
      );
    },
  },
  {
    name: "stat/missing-key",
    requires: [],
    cost: "fast",
    async run(ctx) {
      const key = keyFor(ctx, "stat/missing-key", "absent");

      await expectStorageError(() => ctx.storage.stat(key), {
        code: "NotFound",
        operation: "stat",
      });
    },
  },
  {
    name: "stat/etag-promised",
    requires: ["writeIfUnchanged"],
    cost: "fast",
    async run(ctx) {
      const prefix = prefixFor(ctx, "stat/etag-promised");
      const key = `${prefix}object`;

      const written = await ctx.storage.put(key, patternOf(16));
      const writtenEtag = etagIn(written, "`put`");

      assert(
        etagIn(await ctx.storage.stat(key), "`stat`") === writtenEtag,
        `\`stat\` reports another \`etag\` than the ${JSON.stringify(writtenEtag)} of \`put\``,
      );
      etagIn((await ctx.storage.get(key)).stat, "`get`");
      etagIn(await ctx.storage.copy(key, `${prefix}copied`), "`copy`");
      etagIn(await ctx.storage.move(`${prefix}copied`, `${prefix}moved`), "`move`");

      for (const entry of await collectEntries(ctx.storage.list({ prefix }))) {
        etagIn(entry, `the listing entry of ${JSON.stringify(entry.key)}`);
      }

      // Spec 4.4: a write that changes the bytes changes the `etag`.
      const rewritten = await ctx.storage.put(key, patternOf(16, 1));

      assert(
        etagIn(rewritten, "a `put` of other bytes") !== writtenEtag,
        `A \`put\` of other bytes kept the \`etag\` ${JSON.stringify(writtenEtag)}`,
      );
    },
    async runWithout(ctx) {
      // No storage promises an `etag` here, so the half writes and reads back alone.
      const key = keyFor(ctx, "stat/etag-promised");
      const bytes = patternOf(16);

      await ctx.storage.put(key, bytes);
      assertSameBytes(
        await (await ctx.storage.get(key)).bytes(),
        bytes,
        "the body `get` read back",
      );
    },
  },
];

/** Spec 4.4 promises an `etag` on every description where `writeIfUnchanged` is declared. */
function etagIn(described: ObjectEntry, where: string): string {
  const { etag } = described;

  assert(
    typeof etag === "string" && etag !== "",
    `${where} reports the \`etag\` ${JSON.stringify(etag)}, where the storage promises one`,
  );

  return etag;
}

// Spec 4.4 has `lastModified` carry the time the provider reported when it accepted the
// object, which the clock reading it here is a minute either side of at the most.
function assertWrittenJustNow(lastModified: Date): void {
  assertDate(lastModified, "The last modification `stat` reports");

  assert(
    Math.abs(Date.now() - lastModified.getTime()) <= clockTolerance,
    `\`stat\` reports the last modification as ${lastModified.toISOString()}, which is no moment ago`,
  );
}
