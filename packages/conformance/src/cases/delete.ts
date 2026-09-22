import type { DeleteReport } from "@stowage/core";

import { assert } from "../assertions.ts";
import type { ConformanceCaseSource } from "../case.ts";
import { patternOf } from "./bytes.ts";
import { keyFor, prefixFor } from "./keys.ts";
import { assertNothingBelow, keysBelow, pastOneThousand, putEach } from "./objects.ts";

export const deleteCases: readonly ConformanceCaseSource[] = [
  {
    name: "delete/single",
    requires: [],
    cost: "fast",
    async run(ctx) {
      const key = keyFor(ctx, "delete/single");

      await ctx.storage.put(key, patternOf(16));

      assertAccepted(await ctx.storage.delete(key), 1, "Deleting one key");

      assert(
        !(await ctx.storage.exists(key)),
        "`exists` answers true for the key that was deleted",
      );
    },
  },
  {
    name: "delete/many",
    requires: [],
    cost: "fast",
    async run(ctx) {
      const prefix = prefixFor(ctx, "delete/many");
      const keys = keysBelow(prefix, 30);

      await putEach(ctx, keys, patternOf(8));

      assertAccepted(
        await ctx.storage.delete(...keys),
        keys.length,
        "Deleting 30 keys in one call",
      );

      await assertNothingBelow(ctx, prefix);
    },
  },
  {
    name: "delete/absent-key-succeeds",
    requires: [],
    cost: "fast",
    async run(ctx) {
      // Spec 4.7: deleting is idempotent, so a key that was never there is a key the
      // provider accepted rather than a per-key failure.
      const key = keyFor(ctx, "delete/absent-key-succeeds", "absent");

      assertAccepted(await ctx.storage.delete(key), 1, "Deleting an absent key");
    },
  },
  {
    name: "delete/nothing",
    requires: [],
    cost: "fast",
    async run(ctx) {
      assertAccepted(await ctx.storage.delete(), 0, "Deleting no key at all");
    },
  },
  {
    name: "delete/invalid-key-reported",
    requires: [],
    cost: "fast",
    async run(ctx) {
      const prefix = prefixFor(ctx, "delete/invalid-key-reported");
      const one = `${prefix}one`;
      const two = `${prefix}two`;
      // Spec 4.8: an invalid key reaches the caller through the report, so that the keys
      // beside it in the same call are deleted rather than held up by it.
      const invalid = `${prefix}../object`;

      await putEach(ctx, [one, two], patternOf(8));

      const report = await ctx.storage.delete(one, invalid, two);

      assert(
        report.requested === 3,
        `Deleting three keys reports \`requested: ${report.requested}\``,
      );
      assert(
        report.failed.length === 1,
        `The report holds ${report.failed.length} failures for the one invalid key among three`,
      );

      const failure = report.failed[0];

      assert(
        failure?.code === "InvalidKey",
        `The report holds the failure as \`${failure?.code}\` and not as \`InvalidKey\``,
      );
      assert(
        failure.key === invalid,
        `The failure names the key ${JSON.stringify(failure.key)} and not ${JSON.stringify(invalid)}`,
      );

      await assertNothingBelow(ctx, prefix);
    },
  },
  {
    name: "delete/past-one-thousand",
    requires: [],
    cost: "slow",
    async run(ctx) {
      const prefix = prefixFor(ctx, "delete/past-one-thousand");
      const keys = keysBelow(prefix, pastOneThousand);

      await putEach(ctx, keys, patternOf(8));

      assertAccepted(
        await ctx.storage.delete(...keys),
        keys.length,
        `Deleting ${pastOneThousand} keys in one call`,
      );

      await assertNothingBelow(ctx, prefix);
    },
  },
  {
    name: "deleteAll/below-prefix",
    requires: [],
    cost: "fast",
    async run(ctx) {
      const prefix = prefixFor(ctx, "deleteAll/below-prefix");
      const below = `${prefix}below/`;
      const keys = keysBelow(below, 5);
      const beside = `${prefix}beside`;

      await putEach(ctx, [...keys, beside], patternOf(8));

      assertAccepted(await ctx.storage.deleteAll(below), keys.length, "Deleting below a prefix");

      await assertNothingBelow(ctx, below);

      assert(
        await ctx.storage.exists(beside),
        "`deleteAll` deleted the object beside the prefix as well",
      );
    },
  },
  {
    name: "deleteAll/nothing",
    requires: [],
    cost: "fast",
    async run(ctx) {
      const prefix = prefixFor(ctx, "deleteAll/nothing");

      assertAccepted(await ctx.storage.deleteAll(prefix), 0, "Deleting below an empty prefix");
    },
  },
  {
    name: "deleteAll/past-one-thousand",
    requires: [],
    cost: "slow",
    async run(ctx) {
      const prefix = prefixFor(ctx, "deleteAll/past-one-thousand");
      const keys = keysBelow(prefix, pastOneThousand);

      await putEach(ctx, keys, patternOf(8));

      assertAccepted(
        await ctx.storage.deleteAll(prefix),
        keys.length,
        `Deleting ${pastOneThousand} objects below a prefix in one call`,
      );

      await assertNothingBelow(ctx, prefix);
    },
  },
];

/** A report of spec 4.7 over keys the provider took: the count it covered, and no failure. */
function assertAccepted(report: DeleteReport, requested: number, what: string): void {
  assert(
    report.requested === requested,
    `${what} reports \`requested: ${report.requested}\` and not ${requested}`,
  );
  assert(
    report.failed.length === 0,
    `${what} reports the failure ${JSON.stringify(report.failed[0]?.message)}`,
  );
}
