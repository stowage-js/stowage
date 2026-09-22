import { assert, expectStorageError } from "../assertions.ts";
import type { ConformanceCaseSource } from "../case.ts";
import { keyFor } from "./keys.ts";

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
];

// Spec 4.4 has `lastModified` carry the time the provider reported when it accepted the
// object, which the clock reading it here is a minute either side of at the most.
function assertWrittenJustNow(lastModified: Date): void {
  const time = lastModified instanceof Date ? lastModified.getTime() : Number.NaN;

  assert(
    Number.isFinite(time),
    `\`stat\` reports the last modification as ${JSON.stringify(lastModified)}, which is no \`Date\``,
  );
  assert(
    Math.abs(Date.now() - time) <= clockTolerance,
    `\`stat\` reports the last modification as ${lastModified.toISOString()}, which is no moment ago`,
  );
}
