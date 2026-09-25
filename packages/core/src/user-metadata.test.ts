import { expect, test } from "vitest";

import {
  decodeUserMetadataValue,
  encodeUserMetadataValue,
  isUserMetadataKey,
  userMetadataByteLength,
} from "./user-metadata.ts";

test.each([["content-hash"], ["x.y"], ["1st"], ["Written-By"], ["a_1"], ["!#$%&'*+.^_`|~"]])(
  "%j is a token key",
  (name) => {
    expect(isUserMetadataKey(name, "token")).toBe(true);
  },
);

test.each([["grüße"], ["with space"], ["colon:"], ["slash/"], ["question?"], ["[bracket]"], [""]])(
  "%j is no token key",
  (name) => {
    expect(isUserMetadataKey(name, "token")).toBe(false);
  },
);

test.each([["stowage"], ["with inner  spaces"], ["a=b?c"], ["~!@#$%^&*()"], [""]])(
  "the value %j travels as written",
  (value) => {
    expect(encodeUserMetadataValue(value)).toBe(value);
  },
);

test.each([
  ["a character above ASCII", "grüße"],
  ["a leading space", " padded"],
  ["a trailing space", "padded "],
  ["a line break", "one\ntwo"],
  ["a tab", "one\ttwo"],
  ["what reads as an encoded word", "=?UTF-8?B?Z3LDvMOfZQ==?="],
  ["a bare `=?`", "a=?b"],
])("a value holding %s travels as encoded words and reads back as written", (_, value) => {
  const encoded = encodeUserMetadataValue(value);

  expect(encoded).toMatch(/^=\?UTF-8\?B\?[\w+/=]+\?=(?: =\?UTF-8\?B\?[\w+/=]+\?=)*$/u);
  expect(decodeUserMetadataValue(encoded)).toBe(value);
});

test("a value above ASCII travels as UTF-8 base64", () => {
  expect(encodeUserMetadataValue("grüße")).toBe("=?UTF-8?B?Z3LDvMOfZQ==?=");
});

test("a long value is split into encoded words that each stay within RFC 2047's 75", () => {
  const value = "ü".repeat(200);
  const words = encodeUserMetadataValue(value).split(" ");

  expect(words.length).toBeGreaterThan(1);

  for (const word of words) expect(word.length).toBeLessThanOrEqual(75);

  expect(decodeUserMetadataValue(words.join(" "))).toBe(value);
});

test("a split never falls inside the bytes of one character", () => {
  const value = "a😀".repeat(40);

  expect(decodeUserMetadataValue(encodeUserMetadataValue(value))).toBe(value);
});

test.each([
  ["the `Q` encoding", "=?UTF-8?Q?gr=C3=BC=C3=9Fe_dich?=", "grüße dich"],
  ["the `Q` encoding with lower case hex", "=?UTF-8?Q?gr=c3=bc=c3=9fe?=", "grüße"],
  ["an encoding named in lower case", "=?UTF-8?b?Z3LDvMOfZQ==?=", "grüße"],
  ["a charset named in lower case", "=?utf-8?B?Z3LDvMOfZQ==?=", "grüße"],
  ["another charset", "=?ISO-8859-1?Q?gr=FC=DFe?=", "grüße"],
  [
    "adjacent words, the space between them dropped",
    "=?UTF-8?B?Z3I=?= =?UTF-8?B?w7zDn2U=?=",
    "grüße",
  ],
  [
    "adjacent words across a run of spaces and tabs",
    "=?UTF-8?B?Z3I=?= \t =?UTF-8?B?w7zDn2U=?=",
    "grüße",
  ],
  [
    "a word beside text, the space kept",
    "hello =?UTF-8?B?Z3LDvMOfZQ==?= world",
    "hello grüße world",
  ],
])("reading decodes %s", (_, value, decoded) => {
  expect(decodeUserMetadataValue(value)).toBe(decoded);
});

test.each([
  ["no encoded word", "=?not an encoded word"],
  ["an unknown charset", "=?X-UNKNOWN?B?YQ==?="],
  ["base64 that is none", "=?UTF-8?B?!!!?="],
  ["a `Q` escape that is no hex pair", "=?UTF-8?Q?a=ZZ?="],
  ["bytes the charset does not hold", "=?UTF-8?B?/w==?="],
])("a value holding %s is read as it stands", (_, value) => {
  expect(decodeUserMetadataValue(value)).toBe(value);
});

test("the byte length counts each key and its value as they travel", () => {
  expect(userMetadataByteLength({})).toBe(0);
  expect(userMetadataByteLength({ note: "x".repeat(2044) })).toBe(2048);
  expect(userMetadataByteLength({ a: "b", greeting: "grüße" })).toBe(
    2 + "greeting".length + "=?UTF-8?B?Z3LDvMOfZQ==?=".length,
  );
});
