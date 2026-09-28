import { expect, test } from "vitest";

import type { CapabilityName } from "./capabilities.ts";
import {
  checkUserMetadata,
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

test.each([["a1"], ["a_"], ["_leading"], ["Note"], ["ALL_CAPS_2"]])(
  "%j is an identifier key",
  (name) => {
    expect(isUserMetadataKey(name, "identifier")).toBe(true);
  },
);

test.each([["content-hash"], ["x.y"], ["1st"], ["grüße"], ["with space"], [""]])(
  "%j is no identifier key",
  (name) => {
    expect(isUserMetadataKey(name, "identifier")).toBe(false);
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

test("`always` writes a value as encoded words where it would travel as written", () => {
  expect(encodeUserMetadataValue("stowage", { always: true })).toBe("=?UTF-8?B?c3Rvd2FnZQ==?=");
  expect(decodeUserMetadataValue(encodeUserMetadataValue("a  b", { always: true }))).toBe("a  b");
});

// RFC 2047 gives an encoded word at least one character of text, so an empty value is no
// word at all.
test("`always` leaves an empty value empty", () => {
  expect(encodeUserMetadataValue("", { always: true })).toBe("");
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

// Spec 4.13: the 2 KB of spec 4.3 do not depend on what an adapter encodes beyond the rule.
test("the byte length measures a value as it travels without `always`", () => {
  expect(userMetadataByteLength({ note: "a  b" })).toBe("note".length + "a  b".length);
});

const holdsTokenKeys: readonly CapabilityName[] = ["userMetadata", "userMetadataTokenKeys"];

test.each([
  ["none", undefined],
  ["an empty set", {}],
])("%s passes on a storage that holds no user metadata", (_name, userMetadata) => {
  expect(checkUserMetadata(userMetadata, [])).toEqual({ held: {} });
});

test("the set is held with its keys folded to lower case", () => {
  const check = checkUserMetadata({ "Written-By": "Ada", note: "x" }, holdsTokenKeys);

  expect(check).toEqual({ held: { "written-by": "Ada", note: "x" } });
  expect("held" in check && Object.isFrozen(check.held)).toBe(true);
});

test("a set on a storage that holds no user metadata is unsupported, before any key is read", () => {
  expect(checkUserMetadata({ "no token": "x" }, [])).toEqual({
    refusal: {
      code: "Unsupported",
      message: "This storage holds no user metadata",
      capability: "userMetadata",
    },
  });
});

test.each([["with space"], ["colon:"], ["grüße"], [""]])(
  "the key %j is refused as no ASCII HTTP token",
  (name) => {
    expect(checkUserMetadata({ [name]: "x" }, holdsTokenKeys)).toEqual({
      refusal: {
        code: "InvalidRequest",
        message: `The user metadata key ${JSON.stringify(name)} is no ASCII HTTP token`,
      },
    });
  },
);

test("two keys that fold to one are refused rather than one value dropped", () => {
  expect(checkUserMetadata({ Note: "a", NOTE: "b" }, holdsTokenKeys)).toEqual({
    refusal: {
      code: "InvalidRequest",
      message: 'The user metadata key "note" is given more than once',
    },
  });
});

test.each([
  ["a lone high surrogate", "a\uD800b"],
  ["a lone low surrogate", "a\uDC00b"],
])("a value holding %s is refused rather than measured without its UTF-8 form", (_name, value) => {
  expect(checkUserMetadata({ note: "x", Written: value }, holdsTokenKeys)).toEqual({
    refusal: {
      code: "InvalidRequest",
      message:
        'The user metadata value of "written" holds a lone surrogate, which has no UTF-8 form',
    },
  });
});

test("a value holding a character above the Basic Multilingual Plane is held", () => {
  expect(checkUserMetadata({ note: "😀" }, holdsTokenKeys)).toEqual({ held: { note: "😀" } });
});

test("a set of 2048 encoded header bytes is held", () => {
  expect(checkUserMetadata({ note: "x".repeat(2044) }, holdsTokenKeys)).toHaveProperty("held");
});

test("a set above 2048 encoded header bytes is refused", () => {
  expect(checkUserMetadata({ note: "x".repeat(2045) }, holdsTokenKeys)).toEqual({
    refusal: {
      code: "InvalidRequest",
      message: "The user metadata is 2049 encoded header bytes, above the limit of 2048",
    },
  });
});

test("a key beyond identifiers is unsupported on a storage that holds identifier keys alone", () => {
  expect(checkUserMetadata({ note: "a", "content-hash": "b" }, ["userMetadata"])).toEqual({
    refusal: {
      code: "Unsupported",
      message: 'This storage holds no user metadata key beyond identifiers, such as "content-hash"',
      capability: "userMetadataTokenKeys",
    },
  });
});

test("identifier keys are held on a storage that holds identifier keys alone", () => {
  expect(checkUserMetadata({ Note: "a" }, ["userMetadata"])).toEqual({ held: { note: "a" } });
});

// Spec 4.3 orders the checks, so which refusal a set with several faults meets is promised.
test.each([
  [
    "a key that is no token before a duplicate",
    { "a b": "x", A: "1", a: "2" },
    /no ASCII HTTP token/,
  ],
  ["a duplicate before the bound", { A: "1", a: "x".repeat(3000) }, /more than once/],
  ["a duplicate before a lone surrogate", { A: "1", a: "\uD800" }, /more than once/],
  ["a lone surrogate before the bound", { a: "\uD800", b: "x".repeat(3000) }, /lone surrogate/],
  ["a lone surrogate before a key beyond identifiers", { "x-y": "\uD800" }, /lone surrogate/],
  ["the bound before a key beyond identifiers", { "x-y": "x".repeat(3000) }, /above the limit/],
])("the checks meet %s", (_name, userMetadata, message) => {
  const check = checkUserMetadata(userMetadata, ["userMetadata"]);

  expect("refusal" in check && check.refusal.message).toMatch(message);
});
