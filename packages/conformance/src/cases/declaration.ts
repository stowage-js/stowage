import { capabilityNames } from "@stowage/core";

import { assert } from "../assertions.ts";
import type { ConformanceCaseSource } from "../case.ts";

export const declarationCases: readonly ConformanceCaseSource[] = [
  {
    name: "declaration/valid-names",
    requires: [],
    cost: "fast",
    async run(ctx) {
      const declared: readonly string[] = ctx.storage.capabilities;
      const published: readonly string[] = capabilityNames;

      for (const name of declared) {
        assert(
          published.includes(name),
          `\`capabilities\` holds ${JSON.stringify(name)}, which is no capability name`,
        );
      }

      assert(
        new Set(declared).size === declared.length,
        `\`capabilities\` names a capability twice: ${JSON.stringify(declared)}`,
      );
    },
  },
  {
    name: "declaration/identity",
    requires: [],
    cost: "fast",
    async run(ctx) {
      assertNonEmptyString(ctx.storage.provider, "provider");
      assertNonEmptyString(ctx.storage.bucket, "bucket");
    },
  },
];

// The value arrives as `unknown` because a target may be written in JavaScript, where the
// declared type of a field promises nothing about what the storage carries.
function assertNonEmptyString(value: unknown, field: string): void {
  assert(
    typeof value === "string" && value !== "",
    `\`${field}\` is ${JSON.stringify(value)}, and not a non-empty string`,
  );
}
