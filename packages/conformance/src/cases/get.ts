import type { ObjectStat } from "@stowage/core";

import {
  assert,
  assertSameBytes,
  expectRuntimeError,
  expectStorageError,
  expectUnsupported,
} from "../assertions.ts";
import type { ConformanceCaseSource } from "../case.ts";
import { collect, patternOf } from "./bytes.ts";
import { keyFor, prefixFor } from "./keys.ts";

/** Small enough to read whole in an assertion, and long enough to hold a range within it. */
const rangedSize = 1024;

export const getCases: readonly ConformanceCaseSource[] = [
  {
    name: "get/missing-key",
    requires: [],
    cost: "fast",
    async run(ctx) {
      const key = keyFor(ctx, "get/missing-key", "absent");

      await expectStorageError(() => ctx.storage.get(key), {
        code: "NotFound",
        key,
        operation: "get",
        retryable: false,
        attempts: 1,
      });
    },
  },
  {
    name: "get/stream",
    requires: [],
    cost: "fast",
    async run(ctx) {
      const key = keyFor(ctx, "get/stream");
      const bytes = patternOf(4096);

      await ctx.storage.put(key, bytes);

      const stored = await ctx.storage.get(key);

      assertSameBytes(await collect(stored.stream()), bytes, "the body `stream()` yielded");

      // Spec 4.5 has a cancel cancel the request behind the stream, which is a way of
      // reading an object and not a failure of one.
      const canceled = await ctx.storage.get(key);

      await canceled.stream().cancel();
    },
  },
  {
    name: "get/text-and-json",
    requires: [],
    cost: "fast",
    async run(ctx) {
      const key = keyFor(ctx, "get/text-and-json", "object.json");
      const other = keyFor(ctx, "get/text-and-json", "object.txt");
      const text = '{"grüße":"日本語"}';

      await ctx.storage.put(key, text, { contentType: "application/json" });
      await ctx.storage.put(other, "no JSON in here", { contentType: "text/plain" });

      const read = await (await ctx.storage.get(key)).text();

      assert(read === text, `\`text()\` decoded ${JSON.stringify(read)}`);

      const parsed = await (await ctx.storage.get(key)).json<Record<string, string>>();

      assert(parsed["grüße"] === "日本語", `\`json()\` parsed ${JSON.stringify(parsed)}`);

      await expectRuntimeError(
        async () => await (await ctx.storage.get(other)).json(),
        "SyntaxError",
      );
    },
  },
  {
    name: "get/body-read-once",
    requires: [],
    cost: "fast",
    async run(ctx) {
      const key = keyFor(ctx, "get/body-read-once");

      await ctx.storage.put(key, patternOf(32));

      const stored = await ctx.storage.get(key);

      await stored.bytes();
      await expectStorageError(() => stored.text(), { code: "InvalidRequest" });
    },
  },
  {
    name: "get/stat-from-response",
    requires: [],
    cost: "fast",
    async run(ctx) {
      const key = keyFor(ctx, "get/stat-from-response", "object.txt");

      await ctx.storage.put(key, "a body to describe", { contentType: "text/plain" });

      const stored = await ctx.storage.get(key);
      const described = await ctx.storage.stat(key);

      for (const field of ["key", "size", "contentType", "etag"] as const) {
        assert(
          stored.stat[field] === described[field],
          `\`get\` reports \`${field}: ${JSON.stringify(stored.stat[field])}\` and \`stat\` ${JSON.stringify(described[field])}`,
        );
      }
    },
  },
  {
    name: "get/addressable-keys",
    requires: [],
    cost: "fast",
    async run(ctx) {
      const prefix = prefixFor(ctx, "get/addressable-keys");
      // Spec 4.8 lets `get` name a key stowage would not write, so that an object another
      // tool put in the bucket stays reachable: absent is `NotFound`, not `InvalidKey`.
      const absent = [
        { label: "a key ending in a slash", key: `${prefix}absent/` },
        { label: "a key holding a backslash", key: `${prefix}absent\\key` },
      ];

      await Promise.all(
        absent.map(
          async ({ label, key }) =>
            await expectStorageError(() => ctx.storage.get(key), { code: "NotFound" }, label),
        ),
      );
    },
  },
  {
    name: "get/aborted-signal",
    requires: [],
    cost: "fast",
    async run(ctx) {
      const key = keyFor(ctx, "get/aborted-signal");

      await ctx.storage.put(key, patternOf(16));
      await expectRuntimeError(
        () => ctx.storage.get(key, { signal: AbortSignal.abort() }),
        "AbortError",
      );
    },
  },
  {
    name: "get/range",
    requires: ["rangeReads"],
    cost: "fast",
    async run(ctx) {
      const key = keyFor(ctx, "get/range");
      const bytes = patternOf(rangedSize);

      await ctx.storage.put(key, bytes);

      const middle = await ctx.storage.get(key, { range: { start: 100, end: 199 } });

      assertWholeSize(middle.stat);
      assertSameBytes(await middle.bytes(), bytes.subarray(100, 200), "the bytes of a range");

      const tail = await ctx.storage.get(key, { range: { start: rangedSize - 24 } });

      assertWholeSize(tail.stat);
      assertSameBytes(
        await tail.bytes(),
        bytes.subarray(rangedSize - 24),
        "the bytes of a range without an end",
      );
    },
    async runWithout(ctx) {
      const key = keyFor(ctx, "get/range");

      await ctx.storage.put(key, patternOf(rangedSize));
      await expectUnsupported(
        () => ctx.storage.get(key, { range: { start: 0, end: 15 } }),
        "rangeReads",
      );
    },
  },
  {
    name: "get/range-unsatisfiable",
    requires: ["rangeReads"],
    cost: "fast",
    async run(ctx) {
      const key = keyFor(ctx, "get/range-unsatisfiable");

      await ctx.storage.put(key, patternOf(rangedSize));

      // Spec 4.3 leaves the two on either side of the request: a start the object is too
      // short for is one the provider answers, and bounds in the wrong order never go out.
      await expectStorageError(
        () => ctx.storage.get(key, { range: { start: rangedSize } }),
        { code: "InvalidRequest" },
        "a range starting at the size of the object",
      );
      await expectStorageError(
        () => ctx.storage.get(key, { range: { start: 8, end: 4 } }),
        { code: "InvalidOption" },
        "a range whose start is above its end",
      );
    },
    async runWithout(ctx) {
      const key = keyFor(ctx, "get/range-unsatisfiable");

      await ctx.storage.put(key, patternOf(rangedSize));
      await expectUnsupported(
        () => ctx.storage.get(key, { range: { start: rangedSize } }),
        "rangeReads",
      );
      await expectUnsupported(
        () => ctx.storage.get(key, { range: { start: 8, end: 4 } }),
        "rangeReads",
      );
    },
  },
  {
    name: "get/range-clipped",
    requires: ["rangeReads"],
    cost: "fast",
    async run(ctx) {
      const key = keyFor(ctx, "get/range-clipped");
      const bytes = patternOf(rangedSize);

      await ctx.storage.put(key, bytes);

      const clipped = await ctx.storage.get(key, {
        range: { start: rangedSize - 8, end: 4 * rangedSize },
      });

      assertSameBytes(
        await clipped.bytes(),
        bytes.subarray(rangedSize - 8),
        "the bytes of a range reaching beyond the object",
      );
    },
    async runWithout(ctx) {
      const key = keyFor(ctx, "get/range-clipped");

      await ctx.storage.put(key, patternOf(rangedSize));
      await expectUnsupported(
        () => ctx.storage.get(key, { range: { start: rangedSize - 8, end: 4 * rangedSize } }),
        "rangeReads",
      );
    },
  },
];

// Spec 4.4: after a ranged `get`, `size` is the size of the whole object rather than of
// the range, which is what a caller reading one range of a large object goes by.
function assertWholeSize(described: ObjectStat): void {
  assert(
    described.size === rangedSize,
    `A ranged \`get\` reports ${described.size} bytes for an object of ${rangedSize}`,
  );
}
