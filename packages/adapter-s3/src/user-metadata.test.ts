import { isStorageError } from "@stowage/core";
import { expect, test } from "vitest";

import { readUserMetadata, userMetadataHeaders } from "./user-metadata.ts";

function refusal(act: () => unknown): unknown {
  try {
    act();
  } catch (failure) {
    return failure;
  }

  throw new Error("The call returned");
}

function roundTrip(userMetadata: Record<string, string>): Readonly<Record<string, string>> {
  const { headers } = userMetadataHeaders("stowage", userMetadata, "object.txt");

  return readUserMetadata(new Headers(headers.map(([name, value]) => [name, value])));
}

test("a key travels folded to lower case under the `x-amz-meta-` prefix", () => {
  const { headers, held } = userMetadataHeaders(
    "stowage",
    { "Written-By": "stowage", run: "conformance" },
    "object.txt",
  );

  expect(headers).toEqual([
    ["x-amz-meta-written-by", "stowage"],
    ["x-amz-meta-run", "conformance"],
  ]);
  expect(held).toEqual({ "written-by": "stowage", run: "conformance" });
});

test("a value above ASCII travels as RFC 2047 encoded words of UTF-8", () => {
  const { headers } = userMetadataHeaders("stowage", { greeting: "grüße" }, "object.txt");

  expect(headers).toEqual([["x-amz-meta-greeting", "=?UTF-8?B?Z3LDvMOfZQ==?="]]);
  expect(roundTrip({ greeting: "grüße" })).toEqual({ greeting: "grüße" });
});

test.each([
  ["a leading space", " padded"],
  ["a trailing space", "padded "],
  ["a line break", "one\ntwo"],
  ["a tab", "one\ttwo"],
  ["what reads as an encoded word", "=?UTF-8?B?Z3LDvMOfZQ==?="],
  ["an empty string", ""],
])("a value holding %s comes back as it was written", (_, value) => {
  expect(roundTrip({ note: value })).toEqual({ note: value });
});

test("a long value is split into encoded words that each stay within RFC 2047's 75", () => {
  const value = "ü".repeat(200);
  const { headers } = userMetadataHeaders("stowage", { note: value }, "object.txt");
  const words = headers[0]?.[1].split(" ") ?? [];

  expect(words.length).toBeGreaterThan(1);

  for (const word of words) expect(word.length).toBeLessThanOrEqual(75);

  expect(roundTrip({ note: value })).toEqual({ note: value });
});

test("a split never falls inside the bytes of one character", () => {
  const value = "a😀".repeat(40);

  expect(roundTrip({ note: value })).toEqual({ note: value });
});

test.each([["grüße"], ["with space"], ["colon:"], ["slash/"], ["question?"], ["[bracket]"], [""]])(
  "the key %j is no ASCII HTTP token and is `InvalidRequest` before signing",
  (key) => {
    const failure = refusal(() => userMetadataHeaders("stowage", { [key]: "x" }, "object.txt"));

    expect(isStorageError(failure) && failure.code).toBe("InvalidRequest");
    expect(isStorageError(failure) && failure.attempts).toBe(0);
    expect(isStorageError(failure) && failure.key).toBe("object.txt");
  },
);

test("two keys equal but for case are refused rather than folded into one", () => {
  const failure = refusal(() =>
    userMetadataHeaders("stowage", { Note: "one", note: "two" }, "object.txt"),
  );

  expect(isStorageError(failure) && failure.code).toBe("InvalidRequest");
});

test("the set is measured as encoded header bytes and refused above 2 KB", () => {
  // Four bytes of key and 2044 of value fill the limit exactly.
  expect(() =>
    userMetadataHeaders("stowage", { note: "x".repeat(2044) }, "object.txt"),
  ).not.toThrow();

  const failure = refusal(() =>
    userMetadataHeaders("stowage", { note: "x".repeat(2045) }, "object.txt"),
  );

  expect(isStorageError(failure) && failure.code).toBe("InvalidRequest");
  expect(isStorageError(failure) && failure.attempts).toBe(0);
});

test("a value above ASCII costs its encoded bytes rather than its characters", () => {
  // 800 characters of `ü` are 1600 UTF-8 bytes, which stay below 2 KB and pass it in base64.
  const failure = refusal(() =>
    userMetadataHeaders("stowage", { note: "ü".repeat(800) }, "object.txt"),
  );

  expect(isStorageError(failure) && failure.code).toBe("InvalidRequest");
});

test("reading takes the `x-amz-meta-` fields alone", () => {
  const headers = new Headers({
    "content-type": "text/plain",
    "x-amz-meta-written-by": "stowage",
    "x-amz-missing-meta": "1",
  });

  expect(readUserMetadata(headers)).toEqual({ "written-by": "stowage" });
});

test("reading decodes the `Q` encoding and a charset named in any case", () => {
  const headers = new Headers({ "x-amz-meta-note": "=?utf-8?Q?gr=C3=BC=C3=9Fe_dich?=" });

  expect(readUserMetadata(headers)).toEqual({ note: "grüße dich" });
});

test("reading joins adjacent encoded words and drops the space between them", () => {
  const headers = new Headers({ "x-amz-meta-note": "=?UTF-8?B?Z3I=?= =?UTF-8?B?w7zDn2U=?=" });

  expect(readUserMetadata(headers)).toEqual({ note: "grüße" });
});

test("a value that is no encoded word is read as it stands", () => {
  const headers = new Headers({ "x-amz-meta-note": "=?not an encoded word" });

  expect(readUserMetadata(headers)).toEqual({ note: "=?not an encoded word" });
});
