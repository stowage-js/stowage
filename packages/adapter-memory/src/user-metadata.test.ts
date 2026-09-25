import { type CapabilityName, isStorageError, type StorageError } from "@stowage/core";
import { expect, test } from "vitest";

import { readUserMetadata } from "./user-metadata.ts";

const identifierKeysAlone: readonly CapabilityName[] = ["userMetadata"];

function refusal(userMetadata: Record<string, string>, capabilities: readonly CapabilityName[]) {
  try {
    readUserMetadata(userMetadata, "greeting", capabilities);
  } catch (failure) {
    if (isStorageError(failure)) return failure;

    throw failure;
  }

  throw new Error("The metadata was accepted");
}

function fieldsOf(failure: StorageError) {
  return { code: failure.code, capability: failure.capability, attempts: failure.attempts };
}

test("takes no metadata on a storage declaring none", () => {
  expect(readUserMetadata({}, "greeting", [])).toEqual({});
  expect(readUserMetadata(undefined, "greeting", [])).toEqual({});
});

test("refuses metadata on a storage declaring none before it reads a key", () => {
  expect(fieldsOf(refusal({ "written by": "stowage" }, []))).toEqual({
    code: "Unsupported",
    capability: "userMetadata",
    attempts: 0,
  });
});

test("takes identifier keys on a storage declaring `userMetadata` alone", () => {
  expect(
    readUserMetadata({ WrittenBy: "stowage", _run: "one" }, "greeting", identifierKeysAlone),
  ).toEqual({ writtenby: "stowage", _run: "one" });
});

test.each(["content-hash", "x.y", "1st"])(
  "refuses the key %s beyond identifiers where `userMetadataTokenKeys` is not declared",
  (name) => {
    expect(fieldsOf(refusal({ [name]: "stowage" }, identifierKeysAlone))).toEqual({
      code: "Unsupported",
      capability: "userMetadataTokenKeys",
      attempts: 0,
    });
  },
);

test.each([
  ["a key that is no HTTP token", { grüße: "hallo" }],
  ["a set above 2 KB", { "content-hash": "x".repeat(2048) }],
])("refuses %s as invalid before it reaches the identifier rule", (_name, userMetadata) => {
  expect(fieldsOf(refusal(userMetadata, identifierKeysAlone))).toEqual({
    code: "InvalidRequest",
    capability: undefined,
    attempts: 0,
  });
});
