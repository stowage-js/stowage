import { expect, test } from "vitest";

import type { CapabilityName } from "./capabilities.ts";
import { preconditionRefusal } from "./precondition.ts";

const declaringBoth: readonly CapabilityName[] = ["writeIfAbsent", "writeIfUnchanged"];

test("no precondition passes on every storage", () => {
  expect(preconditionRefusal(undefined, "write", [])).toBeUndefined();
  expect(preconditionRefusal(undefined, "write", declaringBoth)).toBeUndefined();
});

test("`\"absent\"` passes where the storage declares `writeIfAbsent`", () => {
  expect(preconditionRefusal("absent", "write", ["writeIfAbsent"])).toBeUndefined();
});

test.each([
  ["a quoted strong tag's inside", "d41d8cd98f00b204e9800998ecf8427e"],
  ["a multipart etag", "9b2cf535f27731c974343645a3985328-3"],
  ["a generation", "1728651234567890"],
  ["every visible character but the quote", "!#$%&'()*+,-./09:;<=>?@AZ[\\]^_`az{|}~"],
  ["a `W` without the slash", "Wx"],
])("an `etag` of %s passes where the storage declares `writeIfUnchanged`", (_, etag) => {
  expect(preconditionRefusal({ etag }, "write", ["writeIfUnchanged"])).toBeUndefined();
});

test.each([
  ["`\"absent\"`", "absent"],
  ["another string", "present"],
  ["an empty string", ""],
])("%s is `Unsupported` naming `writeIfAbsent` where the storage does not declare it", (_, value) => {
  expect(preconditionRefusal(value, "write", ["writeIfUnchanged"])).toEqual({
    code: "Unsupported",
    capability: "writeIfAbsent",
    message: expect.any(String),
  });
});

test.each([
  ["a well-formed `etag`", { etag: "abc" }],
  ["an `etag` starting with `W/`", { etag: 'W/"x"' }],
  ["an `etag` that is no string", { etag: 42 }],
  ["an object without `etag`", {}],
])("%s is `Unsupported` naming `writeIfUnchanged` where the storage does not declare it", (_, value) => {
  expect(preconditionRefusal(value, "write", ["writeIfAbsent"])).toEqual({
    code: "Unsupported",
    capability: "writeIfUnchanged",
    message: expect.any(String),
  });
});

test.each([
  ["a number", 42],
  ["`null`", null],
  ["a boolean", true],
  ["a function", () => "absent"],
])("%s is `InvalidOption` on a storage declaring nothing", (_, value) => {
  expect(preconditionRefusal(value, "write", [])).toEqual({
    code: "InvalidOption",
    message: expect.stringContaining("`onlyIf`"),
  });
});

test.each([
  ["a string other than `\"absent\"`", "present"],
  ["an empty string", ""],
  ["`\"absent\"` in another case", "Absent"],
  ["an empty `etag`", { etag: "" }],
  ["an `etag` holding a quote", { etag: '"abc"' }],
  ["an `etag` starting with `W/`", { etag: "W/abc" }],
  ["an `etag` holding a space", { etag: "a b" }],
  ["an `etag` holding a character above ASCII", { etag: "grüße" }],
  ["an `etag` holding a control character", { etag: "a\tb" }],
  ["an `etag` that is no string", { etag: 42 }],
  ["an object without `etag`", {}],
  ["an object beside `etag`", { etag: "abc", generation: "1" }],
])("%s is `InvalidOption` naming `onlyIf` where the storage declares both", (_, value) => {
  expect(preconditionRefusal(value, "write", declaringBoth)).toEqual({
    code: "InvalidOption",
    message: expect.stringContaining("`onlyIf`"),
  });
});

test("the message never names the value it refused", () => {
  const refusal = preconditionRefusal({ etag: "W/secret-tag" }, "write", declaringBoth);

  expect(refusal?.message).not.toContain("secret-tag");
});
