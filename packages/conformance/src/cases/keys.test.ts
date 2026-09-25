import { invalidKeyReason } from "@stowage/core";
import { expect, test } from "vitest";

import { createKeyPrefix } from "../run.ts";
import { acceptedKeys, keyOfBytes, refusedWritableKeys } from "./keys.ts";

const utf8 = new TextEncoder();

const prefix = `${createKeyPrefix()}put/accepted-keys/`;

const bytesIn = (key: string): number => utf8.encode(key).byteLength;

test("every key of the accepted list of spec 9.7 is one `put` takes", () => {
  for (const { label, key } of acceptedKeys(prefix)) {
    expect(`${label}: ${invalidKeyReason(key, "writable")}`).toBe(`${label}: undefined`);
  }
});

test("the boundary key is 1024 UTF-8 bytes in segments of at most 255", () => {
  const boundary = acceptedKeys(prefix).find((one) => one.label === "a key of 1024 bytes")?.key;

  expect(boundary).toBeDefined();
  expect(bytesIn(boundary ?? "")).toBe(1024);
  expect(Math.max(...(boundary ?? "").split("/").map(bytesIn))).toBeLessThanOrEqual(255);
});

test("every key of the refused writable list of spec 9.7 is one `put` refuses", () => {
  for (const { label, key } of refusedWritableKeys(prefix)) {
    expect(`${label}: ${invalidKeyReason(key, "writable") === undefined}`).toBe(`${label}: false`);
  }
});

test("a refused key the case asks `exists` about is one the addressable rule allows", () => {
  const asked = refusedWritableKeys(prefix).filter((one) => one.existsAnswers !== "unasked");

  expect(asked.map((one) => one.label)).toEqual(["a/", "a\\b", "a key of 1025 bytes"]);

  for (const { label, key } of asked) {
    expect(`${label}: ${invalidKeyReason(key, "addressable")}`).toBe(`${label}: undefined`);
  }
});

test("a key of a length the prefix leaves no room for is a failure of the suite", () => {
  expect(() => keyOfBytes(prefix, bytesIn(prefix))).toThrow("does not fit");
});
