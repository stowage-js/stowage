import { expect, test } from "vitest";

import type { CapabilityName } from "./capabilities.ts";
import { checkContentHeaders, type ContentHeaders, isHeaderValue } from "./content-headers.ts";
import type { Refusal } from "./errors.ts";

const declaring: readonly CapabilityName[] = ["contentHeaders"];

/** `Content-Type` and `Content-Disposition`, which a padded disposition fills to the bound. */
const headerNameBytes = "Content-Type".length + "Content-Disposition".length;
const byteLimit = 2048;

function refusalOf(
  headers: ContentHeaders,
  contentType: string | undefined,
  capabilities: readonly CapabilityName[],
): Refusal | undefined {
  const check = checkContentHeaders(headers, contentType, capabilities);

  return "refusal" in check ? check.refusal : undefined;
}

test.each([
  ["a single character", "x"],
  ["a cache directive", "public, max-age=60, immutable"],
  ["a tab and a run of spaces inside", 'attachment;\tfilename="a  b.pdf"'],
  ["every visible character", "!\"#$%&'()*+,-./09:;<=>?@AZ[\\]^_`az{|}~"],
])("%s is a header value", (_, value) => {
  expect(isHeaderValue(value)).toBe(true);
});

test.each([
  ["nothing", ""],
  ["a space at the start", " public"],
  ["a space at the end", "public "],
  ["a tab at the end", "public\t"],
  ["a line feed", "one\ntwo"],
  ["a carriage return", "one\rtwo"],
  ["a NUL", "one\u0000two"],
  ["DEL", "one\u007Ftwo"],
  ["a character above ASCII", "grüße"],
  ["a character above U+00FF", "日本"],
])("a value holding %s is no header value", (_, value) => {
  expect(isHeaderValue(value)).toBe(false);
});

test("a put carrying none of the three passes, whatever its content type", () => {
  expect(refusalOf({}, "x".repeat(3 * byteLimit), declaring)).toBeUndefined();
  expect(refusalOf({}, undefined, [])).toBeUndefined();
});

test("a header given as `undefined` counts as not carried", () => {
  const headers: ContentHeaders = {
    cacheControl: undefined,
    contentDisposition: undefined,
    contentLanguage: undefined,
  };

  expect(refusalOf(headers, "x".repeat(3 * byteLimit), [])).toBeUndefined();
});

test("the three as written pass where the storage declares `contentHeaders`", () => {
  const headers: ContentHeaders = {
    cacheControl: "public, max-age=60, immutable",
    contentDisposition: 'attachment;\tfilename="a  b.pdf"',
    contentLanguage: "de-AT, en",
  };

  expect(refusalOf(headers, "text/plain", declaring)).toBeUndefined();
});

test.each(["cacheControl", "contentDisposition", "contentLanguage"] as const)(
  "`%s` is `Unsupported` naming `contentHeaders` where the storage does not declare it",
  (option) => {
    expect(refusalOf({ [option]: "x" }, undefined, ["rangeReads"])).toEqual({
      code: "Unsupported",
      capability: "contentHeaders",
      message: expect.any(String),
    });
  },
);

test("an empty value is `Unsupported` before its form is read", () => {
  expect(refusalOf({ cacheControl: "" }, undefined, [])).toMatchObject({
    code: "Unsupported",
    capability: "contentHeaders",
  });
});

test.each([
  ["no string", 4711],
  ["padded with a space at either end", " no-store "],
  ["holding a line feed", "no-store\nx-injected: 1"],
  ["holding a character above ASCII", "grüße"],
])("a value %s is `InvalidOption` naming the option and never the value", (_, value) => {
  // A caller writing JavaScript may hand over what the declared type does not allow.
  // oxlint-disable-next-line no-unsafe-type-assertion -- the point of the test
  const headers = { contentDisposition: value } as ContentHeaders;
  const refusal = refusalOf(headers, undefined, declaring);

  expect(refusal?.code).toBe("InvalidOption");
  expect(refusal?.message).toContain("`contentDisposition`");
  expect(refusal?.message).not.toContain(String(value).trim());
});

test("an empty value is `InvalidOption` where the storage declares `contentHeaders`", () => {
  expect(refusalOf({ cacheControl: "" }, undefined, declaring)).toEqual({
    code: "InvalidOption",
    message: expect.stringContaining("`cacheControl`"),
  });
});

test("the form of every header comes before the bounds", () => {
  const refusal = refusalOf(
    { cacheControl: "x".repeat(3 * byteLimit), contentLanguage: "" },
    undefined,
    declaring,
  );

  expect(refusal?.code).toBe("InvalidOption");
  expect(refusal?.message).toContain("`contentLanguage`");
});

test("2,048 bytes of names and values with `Content-Type` pass", () => {
  const contentType = "text/plain";
  const contentDisposition = "x".repeat(byteLimit - headerNameBytes - contentType.length);

  expect(refusalOf({ contentDisposition }, contentType, declaring)).toBeUndefined();
});

test("2,049 bytes of names and values with `Content-Type` are `InvalidRequest`", () => {
  const contentType = "text/plain";
  const contentDisposition = "x".repeat(byteLimit - headerNameBytes - contentType.length + 1);

  expect(refusalOf({ contentDisposition }, contentType, declaring)).toEqual({
    code: "InvalidRequest",
    message: expect.any(String),
  });
});

test("an absent content type counts as `application/octet-stream`", () => {
  const contentDisposition = "x".repeat(
    byteLimit - headerNameBytes - "application/octet-stream".length,
  );

  expect(refusalOf({ contentDisposition }, undefined, declaring)).toBeUndefined();
  expect(
    refusalOf({ contentDisposition: `${contentDisposition}x` }, undefined, declaring),
  ).toMatchObject({ code: "InvalidRequest" });
});

test("the content type counts in UTF-8 bytes", () => {
  // `contentType` keeps its own rules (ADR 0058), so it may hold what a header value may not.
  const contentType = "text/plain; title=ü";
  const contentDisposition = "x".repeat(byteLimit - headerNameBytes - contentType.length);

  expect(refusalOf({ contentDisposition }, contentType, declaring)).toMatchObject({
    code: "InvalidRequest",
  });
});

test("every header carried counts with its name", () => {
  const headers: ContentHeaders = {
    cacheControl: "no-store",
    contentDisposition: "inline",
    contentLanguage: "de",
  };
  const carried =
    "Content-Type".length +
    "text/plain".length +
    "Cache-Control".length +
    "no-store".length +
    "Content-Disposition".length +
    "inline".length +
    "Content-Language".length +
    "de".length;
  const padded = { ...headers, cacheControl: "x".repeat(byteLimit - carried + "no-store".length) };

  expect(refusalOf(padded, "text/plain", declaring)).toBeUndefined();
  expect(refusalOf({ ...padded, contentLanguage: "de-" }, "text/plain", declaring)).toMatchObject({
    code: "InvalidRequest",
  });
});

test("100 characters of `contentLanguage` pass", () => {
  expect(refusalOf({ contentLanguage: "x".repeat(100) }, undefined, declaring)).toBeUndefined();
});

test("101 characters of `contentLanguage` are `InvalidRequest`", () => {
  expect(refusalOf({ contentLanguage: "x".repeat(101) }, undefined, declaring)).toEqual({
    code: "InvalidRequest",
    message: expect.any(String),
  });
});

test("what passes is held frozen, without a member for a header not carried", () => {
  const check = checkContentHeaders(
    { cacheControl: "no-store", contentDisposition: undefined },
    "text/plain",
    declaring,
  );

  expect(check).toEqual({ held: { cacheControl: "no-store" } });
  expect("held" in check && Object.isFrozen(check.held)).toBe(true);
  expect("held" in check && Object.hasOwn(check.held, "contentDisposition")).toBe(false);
});

test("a put carrying none of the three holds none, also where the storage declares none", () => {
  expect(checkContentHeaders({}, undefined, [])).toEqual({ held: {} });
});

test("each header is read once, so what passed is what is held", () => {
  const values = ["inline", "attachment\nx-injected: 1"];
  const headers: ContentHeaders = {
    get contentDisposition() {
      return values.shift();
    },
  };

  expect(checkContentHeaders(headers, undefined, declaring)).toEqual({
    held: { contentDisposition: "inline" },
  });
});
