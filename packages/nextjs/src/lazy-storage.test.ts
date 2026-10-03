import { type MemoryStorage, memoryStorage } from "@stowage/adapter-memory";
import { expect, test, vi } from "vitest";

import { lazyStorage } from "./index.ts";

test("runs the factory on the getter's first call and not before", () => {
  const factory = vi.fn<() => MemoryStorage>(memoryStorage);
  const storage = lazyStorage(factory);

  expect(factory).not.toHaveBeenCalled();

  storage();

  expect(factory).toHaveBeenCalledOnce();
});

test("keeps the storage the factory returned for every later call", () => {
  const factory = vi.fn<() => MemoryStorage>(memoryStorage);
  const storage = lazyStorage(factory);
  const first = storage();

  expect(storage()).toBe(first);
  expect(storage()).toBe(first);
  expect(factory).toHaveBeenCalledOnce();
});

test("caches no factory that throws, so a later call runs it again", () => {
  const avatars = memoryStorage();
  let bucket: string | undefined;
  const factory = vi.fn<() => MemoryStorage>(() => {
    if (bucket === undefined) throw new Error("AVATARS_BUCKET is not set");

    return avatars;
  });
  const storage = lazyStorage(factory);

  expect(storage).toThrow("AVATARS_BUCKET is not set");
  expect(storage).toThrow("AVATARS_BUCKET is not set");

  bucket = "avatars";

  expect(storage()).toBe(avatars);
  expect(storage()).toBe(avatars);
  expect(factory).toHaveBeenCalledTimes(3);
});

// Spec 13: one call holds one storage, with no name that two calls could share.
test("holds one storage per call, however alike the factories", () => {
  const avatars = lazyStorage(memoryStorage);
  const documents = lazyStorage(memoryStorage);

  expect(avatars()).not.toBe(documents());
});

// Spec 13: the storage lives in the module instance the getter lives in, not on `globalThis`.
test("keeps the storage off `globalThis`", () => {
  const before = Reflect.ownKeys(globalThis);
  const storage = lazyStorage(memoryStorage);

  storage();

  expect(Reflect.ownKeys(globalThis)).toEqual(before);
});
