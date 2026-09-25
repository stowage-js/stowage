import { afterEach, expect, test, vi } from "vitest";

import { readEnvironment } from "./environment.ts";

afterEach(() => {
  vi.unstubAllGlobals();
});

/**
 * A `process` whose `env` answers through `read` and, as Deno does without the unscoped
 * permission, refuses to be enumerated.
 */
function stubProcessEnv(read: (name: string) => string | undefined): void {
  vi.stubGlobal("process", {
    env: new Proxy(
      {},
      {
        get: (_target, name) => read(String(name)),
        ownKeys: () => {
          throw new Error("Requires env access to all");
        },
      },
    ),
  });
}

test("it reads the one variable it is asked for", () => {
  const read = vi.fn<(name: string) => string | undefined>((name) =>
    name === "STOWAGE_EXAMPLE" ? "value" : undefined,
  );

  stubProcessEnv(read);

  expect(readEnvironment("STOWAGE_EXAMPLE")).toBe("value");
  expect(read.mock.calls).toEqual([["STOWAGE_EXAMPLE"]]);
});

test("an unset variable reads as an empty string", () => {
  stubProcessEnv(() => undefined);

  expect(readEnvironment("STOWAGE_EXAMPLE")).toBe("");
});

// ADR 0007: a Worker without `nodejs_compat` has no `process` at all.
test("a missing `process` reads as an empty string rather than a `ReferenceError`", () => {
  vi.stubGlobal("process", undefined);

  expect(readEnvironment("STOWAGE_EXAMPLE")).toBe("");
});

test("a `process` without `env` reads as an empty string", () => {
  vi.stubGlobal("process", {});

  expect(readEnvironment("STOWAGE_EXAMPLE")).toBe("");
});

// ADR 0007: Deno without `--allow-env` throws `NotCapable` instead of answering `undefined`.
test("a read the runtime refuses reads as an empty string", () => {
  stubProcessEnv((name) => {
    throw new Error(`Requires env access to ${name}`);
  });

  expect(readEnvironment("STOWAGE_EXAMPLE")).toBe("");
});
