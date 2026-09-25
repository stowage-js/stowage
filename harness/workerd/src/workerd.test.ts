import { describe, expect, test } from "vitest";

import { describeWorkerd } from "./describe-workerd.ts";

const probes = await describeWorkerd({ describe, test });

describe("the flags of spec 1", () => {
  test("leave the harness worker no Node API", () => {
    expect(probes.harness.nodeApi).toEqual({
      process: "undefined",
      Buffer: "undefined",
      "node:os": "rejected",
      "node:buffer": "rejected",
    });
  });

  // Without this, a probe that could not see a Node API at all would pass the test above.
  test("differ from the defaults, where the same worker reaches Node APIs", () => {
    expect(probes.defaults.nodeApi).toEqual({
      process: "object",
      Buffer: "function",
      "node:os": "loaded",
      "node:buffer": "loaded",
    });
  });
});
