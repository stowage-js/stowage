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

describe("`fromEnv` on `workerd`", () => {
  // ADR 0007: the `typeof process` guard. The worker has an `AWS_ACCESS_KEY_ID` binding,
  // and without `process` nothing reaches it.
  test("finds no `process` at the flags of spec 1 and names the missing variable", () => {
    expect(probes.harness.fromEnv).toEqual({
      refusal: {
        code: "InvalidCredentials",
        message: expect.stringContaining("AWS_ACCESS_KEY_ID"),
      },
    });
  });

  // Spec 7.3: under `nodejs_compat`, which the pinned date turns on by default, the
  // bindings of `workerd.capnp` reach `process.env`.
  test("reads the three variables from the bindings at the defaults", () => {
    expect(probes.defaults.fromEnv).toEqual({
      credentials: {
        accessKeyId: "access-key-from-binding",
        secretAccessKey: "secret-from-binding",
        sessionToken: "session-token-from-binding",
      },
    });
  });
});
