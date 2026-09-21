import { expect, test } from "vitest";

import { invalidKeyReason } from "./keys.ts";

/** 1024 UTF-8 bytes in segments of at most 255, which is the length a file system holds. */
const longestWritableKey = Array.from({ length: 5 }, () => "a".repeat(204)).join("/");

const accepted = [
  ["a single character", "a"],
  ["a space and a dot", "hello world.txt"],
  ["segments", "docs/2026/report.pdf"],
  ["a hash", "a#b"],
  ["a percent", "100%"],
  ["a question mark", "q?x=1"],
  ["a plus", "a+b"],
  ["an apostrophe", "it's"],
  ["characters above ASCII", "Grüße/日本語/ключ.txt"],
  ["1024 bytes in segments of at most 255", longestWritableKey],
  ["255 bytes in one segment", "a".repeat(255)],
] as const;

test.each(accepted)("accepts a key holding %s as writable", (_name, key) => {
  expect(invalidKeyReason(key, "writable")).toBeUndefined();
});

test.each(accepted)("accepts a key holding %s as addressable and as a prefix", (_name, key) => {
  expect(invalidKeyReason(key, "addressable")).toBeUndefined();
  expect(invalidKeyReason(key, "prefix")).toBeUndefined();
});

test.each([
  ["the empty string", "", /empty/],
  ["a leading slash", "/a", /starts with a slash/],
  ["a trailing slash", "a/", /ends with a slash/],
  ["an empty segment", "a//b", /empty segment/],
  ["a dot segment", "./a", /"\."/],
  ["a dot-dot segment", "a/../b", /"\.\."/],
  ["nothing but a dot-dot segment", "..", /"\.\."/],
  ["a backslash", "a\\b", /backslash/],
  ["a null character", "a\u0000b", /U\+0000/],
  ["a unit separator", "a\u001Fb", /U\+001F/],
  ["a delete character", "a\u007Fb", /U\+007F/],
  ["1025 bytes", "a".repeat(1025), /1025/],
])("refuses a key holding %s as writable", (_name, key, reason) => {
  expect(invalidKeyReason(key, "writable")).toMatch(reason);
});

test.each([
  ["a trailing slash", "a/"],
  ["a backslash", "a\\b"],
  ["1025 bytes", "a".repeat(1025)],
])("accepts a key holding %s as addressable and refuses it as writable", (_name, key) => {
  expect(invalidKeyReason(key, "addressable")).toBeUndefined();
  expect(invalidKeyReason(key, "writable")).toBeTypeOf("string");
});

test.each([
  ["the empty string", "", /empty/],
  ["a leading slash", "/a", /starts with a slash/],
  ["an empty segment", "a//b", /empty segment/],
  ["a dot segment", "./a", /"\."/],
  ["a dot-dot segment", "a/../b", /"\.\."/],
  ["nothing but a dot segment", ".", /"\."/],
  ["a null character", "a\u0000b", /U\+0000/],
])("refuses a key holding %s as addressable", (_name, key, reason) => {
  expect(invalidKeyReason(key, "addressable")).toMatch(reason);
});

test.each([
  ["nothing", ""],
  ["a segment boundary", "docs/"],
  ["the middle of a segment", "docs/20"],
  ["a whole key", "docs/2026/report.pdf"],
])("accepts a prefix ending on %s", (_name, prefix) => {
  expect(invalidKeyReason(prefix, "prefix")).toBeUndefined();
});

test.each([
  ["a leading slash", "/docs", /starts with a slash/],
  ["an empty segment", "docs//2026", /empty segment/],
  ["a dot-dot segment", "docs/../2026", /"\.\."/],
  ["a null character", "docs\u0000", /U\+0000/],
])("refuses a prefix holding %s", (_name, prefix, reason) => {
  expect(invalidKeyReason(prefix, "prefix")).toMatch(reason);
});

test("measures the length in UTF-8 bytes rather than in characters", () => {
  const key = "ü".repeat(513);

  expect(key.length).toBe(513);
  expect(invalidKeyReason("ü".repeat(512), "writable")).toBeUndefined();
  expect(invalidKeyReason(key, "writable")).toMatch(/1026/);
});

test("measures the Unicode form it was given rather than a normalized one", () => {
  const decomposed = "ü".normalize("NFD").repeat(342);

  expect(invalidKeyReason(decomposed, "writable")).toMatch(/1026/);
  expect(invalidKeyReason(decomposed.normalize("NFC"), "writable")).toBeUndefined();
});
