import { expect, test } from "vitest";

import { isOneKeyWithOptions } from "./delete-form.ts";

test("one key and its options are the form for one key", () => {
  expect(isOneKeyWithOptions(["object.txt", {}])).toBe(true);
  expect(isOneKeyWithOptions(["object.txt", { onlyIf: { etag: "abc" } }])).toBe(true);
});

test("keys alone are the variadic form, however many", () => {
  expect(isOneKeyWithOptions([])).toBe(false);
  expect(isOneKeyWithOptions(["object.txt"])).toBe(false);
  expect(isOneKeyWithOptions(["object.txt", "other.txt"])).toBe(false);
  expect(isOneKeyWithOptions(["a.txt", "b.txt", "c.txt"])).toBe(false);
});

// A caller outside TypeScript may hand `null` where the options go, which `typeof` reads
// as an object.
test("`null` in the place of the options is no options", () => {
  // oxlint-disable-next-line no-unsafe-type-assertion -- the point of the test
  expect(isOneKeyWithOptions(["object.txt", null as unknown as string])).toBe(false);
});
