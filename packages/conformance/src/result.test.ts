import { StorageError } from "@stowage/core";
import { expect, test } from "vitest";

import { serializeError } from "./result.ts";

test("an error becomes its name, its message and its stack", () => {
  const serialized = serializeError(new RangeError("out of bounds"));

  expect(serialized.name).toBe("RangeError");
  expect(serialized.message).toBe("out of bounds");
  expect(serialized.stack).toContain("RangeError");
  expect(serialized.code).toBeUndefined();
});

test("a `StorageError` carries its code and leaves its cause behind", () => {
  const serialized = serializeError(
    new StorageError({
      code: "InvalidKey",
      message: "The key ends with a slash",
      operation: "put",
      bucket: "stub",
      provider: "stub",
      attempts: 0,
      cause: new Error("the one underneath"),
    }),
  );

  expect(serialized.code).toBe("InvalidKey");
  expect(serialized).not.toHaveProperty("cause");
  expect(Object.keys(serialized).toSorted()).toEqual(["code", "message", "name", "stack"]);
});

test("a thrown value that is no error becomes a name and a message all the same", () => {
  expect(serializeError("no")).toEqual({ name: "Error", message: "no" });
  expect(serializeError(undefined)).toEqual({ name: "Error", message: "undefined" });
});

test("an error-shaped value from another realm is read field by field", () => {
  // `instanceof Error` answers `false` for a value a worker hands back, which is where
  // `runAll` reports from (ADR 0006).
  expect(serializeError({ name: "AbortError", message: "aborted", stack: "at worker" })).toEqual({
    name: "AbortError",
    message: "aborted",
    stack: "at worker",
  });
});

test("a proxy whose fields cannot be read still becomes an error", () => {
  const thrown = new Proxy(
    {},
    {
      get: () => {
        throw new Error("get trap");
      },
      has: () => true,
    },
  );

  expect(serializeError(thrown)).toEqual({ name: "Error", message: "Unknown error" });
});

test("a proxy that cannot be inspected for the storage-error brand omits a code", () => {
  const thrown = new Proxy(
    { name: "RemoteError", message: "remote failure" },
    {
      has: () => {
        throw new Error("has trap");
      },
    },
  );

  expect(serializeError(thrown)).toEqual({ name: "RemoteError", message: "remote failure" });
});
