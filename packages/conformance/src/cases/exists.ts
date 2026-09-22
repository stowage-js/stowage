import { assert, expectStorageError } from "../assertions.ts";
import type { ConformanceCaseSource } from "../case.ts";
import { patternOf } from "./bytes.ts";
import { keyFor, prefixFor } from "./keys.ts";

export const existsCases: readonly ConformanceCaseSource[] = [
  {
    name: "exists/answers",
    requires: [],
    cost: "fast",
    async run(ctx) {
      const stored = keyFor(ctx, "exists/answers", "object");
      const absent = keyFor(ctx, "exists/answers", "absent");
      // Spec 4.8 has no directories, so a key ending in a slash is a key like any other
      // and an absent one is absent rather than a level of the storage that is there.
      const trailingSlash = keyFor(ctx, "exists/answers", "absent/");

      await ctx.storage.put(stored, patternOf(16));

      assert(await ctx.storage.exists(stored), "`exists` answers false for a stored key");
      assert(!(await ctx.storage.exists(absent)), "`exists` answers true for an absent key");
      assert(
        !(await ctx.storage.exists(trailingSlash)),
        "`exists` answers true for an absent key ending in a slash",
      );
    },
  },
  {
    name: "exists/invalid-key",
    requires: [],
    cost: "fast",
    async run(ctx) {
      const key = `${prefixFor(ctx, "exists/invalid-key")}../object`;

      await expectStorageError(() => ctx.storage.exists(key), { code: "InvalidKey" });
    },
  },
];
