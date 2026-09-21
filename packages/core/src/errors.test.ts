import { expect, test, vi } from "vitest";

import { isStorageError, StorageError, type StorageErrorFields } from "./errors.ts";

const fields = (overrides: Partial<StorageErrorFields> = {}): StorageErrorFields => ({
  code: "NotFound",
  message: 'No object under the key "greeting"',
  operation: "get",
  bucket: "memory",
  provider: "memory",
  attempts: 1,
  ...overrides,
});

test("carries the fields it was constructed from", () => {
  const cause = new Error("underneath");
  const error = new StorageError(
    fields({
      key: "greeting",
      status: 404,
      providerCode: "NoSuchKey",
      requestId: "TX-1",
      retryable: true,
      cause,
    }),
  );

  expect(error.code).toBe("NotFound");
  expect(error.message).toBe('No object under the key "greeting"');
  expect(error.operation).toBe("get");
  expect(error.key).toBe("greeting");
  expect(error.bucket).toBe("memory");
  expect(error.provider).toBe("memory");
  expect(error.status).toBe(404);
  expect(error.providerCode).toBe("NoSuchKey");
  expect(error.requestId).toBe("TX-1");
  expect(error.retryable).toBe(true);
  expect(error.attempts).toBe(1);
  expect(error.cause).toBe(cause);
});

test("is an error named after its class", () => {
  const error = new StorageError(fields());

  expect(error).toBeInstanceOf(Error);
  expect(error.name).toBe("StorageError");
  expect(error.stack).toContain("StorageError");
});

test("leaves out what it was not told", () => {
  const error = new StorageError(fields());

  expect(error.key).toBeUndefined();
  expect(error.status).toBeUndefined();
  expect(error.providerCode).toBeUndefined();
  expect(error.requestId).toBeUndefined();
  expect(error.capability).toBeUndefined();
  expect("cause" in error).toBe(false);
});

test("reports a condition as permanent unless it was told otherwise", () => {
  expect(new StorageError(fields()).retryable).toBe(false);
});

test("names the capability an `Unsupported` failure needs", () => {
  const error = new StorageError(
    fields({ code: "Unsupported", message: "Ranges", capability: "rangeReads" }),
  );

  expect(error.capability).toBe("rangeReads");
});

test("refuses an `Unsupported` failure that names no capability", () => {
  expect(() => new StorageError(fields({ code: "Unsupported", message: "Ranges" }))).toThrow(
    TypeError,
  );
});

test("recognizes a storage error", () => {
  expect(isStorageError(new StorageError(fields()))).toBe(true);
});

test.each([
  ["a plain error", new Error("boom")],
  ["a type error", new TypeError("boom")],
  ["null", null],
  ["undefined", undefined],
  ["a string", "NotFound"],
  ["an object shaped like one", { code: "NotFound", attempts: 1 }],
])("does not recognize %s", (_name, value) => {
  expect(isStorageError(value)).toBe(false);
});

test("recognizes an error thrown by a second copy of the core", async () => {
  const first = await import("./errors.ts");
  vi.resetModules();
  const second = await import("./errors.ts");

  expect(second.StorageError).not.toBe(first.StorageError);

  const error = new first.StorageError(fields());

  expect(error).not.toBeInstanceOf(second.StorageError);
  expect(second.isStorageError(error)).toBe(true);
  expect(first.isStorageError(new second.StorageError(fields()))).toBe(true);
});
