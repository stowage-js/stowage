import { expect, test } from "vitest";

import { parseXml, XmlSyntaxError } from "./xml.ts";

test("it reads nested elements and their text", () => {
  const root = parseXml(
    '<?xml version="1.0" encoding="UTF-8"?>\n<ListBucketResult xmlns="http://s3.amazonaws.com/doc/2006-03-01/"><Name>stowage</Name><Contents><Key>a.txt</Key></Contents></ListBucketResult>',
  );

  expect(root.name).toBe("ListBucketResult");
  expect(root.children.map((child) => child.name)).toEqual(["Name", "Contents"]);
  expect(root.children[0]?.text).toBe("stowage");
  expect(root.children[1]?.children[0]?.text).toBe("a.txt");
});

// Keys are user controlled and arrive escaped (ADR 0003); SeaweedFS writes `&#34;` where
// S3 writes `&quot;`, and both are the same character.
test.each([
  ["&amp;", "&"],
  ["&lt;", "<"],
  ["&gt;", ">"],
  ["&quot;", '"'],
  ["&apos;", "'"],
  ["&#34;", '"'],
  ["&#x2F;", "/"],
  ["&#128512;", "😀"],
  ["&#x1F600;", "😀"],
])("the entity %s is read as %s", (entity, character) => {
  expect(parseXml(`<Key>a${entity}b</Key>`).text).toBe(`a${character}b`);
});

// ADR 0027: S3 writes a key character XML 1.0 cannot carry as a reference, and the key is
// read back byte for byte rather than refused, although XML 1.0's `Char` excludes it.
test.each([
  ["&#xFFFE;", "\uFFFE"],
  ["&#xffff;", "\uFFFF"],
  ["&#65534;", "\uFFFE"],
  ["&#x7;", "\u0007"],
])("the reference %s outside XML 1.0 is read as the character it names", (entity, character) => {
  expect(parseXml(`<Key>a${entity}b</Key>`).text).toBe(`a${character}b`);
});

test.each([
  ["CDATA", "<Key><![CDATA[a<b]]></Key>"],
  ["DTD", '<?xml version="1.0"?><!DOCTYPE Key [<!ENTITY e "x">]><Key>&e;</Key>'],
])("a %s is refused by name", (construct, document) => {
  expect(() => parseXml(document)).toThrow(new RegExp(`A ${construct} [a-z ]*is refused`, "u"));
});

// ADR 0003: a document outside the subset is an error and never a value read around it.
test.each([
  ["an entity no DTD defines", "<Key>&nbsp;</Key>"],
  ["an ampersand that starts no entity", "<Key>a & b</Key>"],
  ["an entity never closed", "<Key>&amp</Key>"],
  ["a hexadecimal reference with a capital X", "<Key>&#X2f;</Key>"],
  ["a reference to U+0000", "<Key>&#0;</Key>"],
  ["a hexadecimal reference to U+0000", "<Key>&#x0;</Key>"],
  ["a reference to a surrogate", "<Key>&#xD800;</Key>"],
  ["a reference to a trailing surrogate", "<Key>&#57343;</Key>"],
  ["a reference past U+10FFFF", "<Key>&#x110000;</Key>"],
  ["an element closed by another", "<Key>a</Name>"],
  ["an element never closed", "<ListBucketResult><Key>a</Key>"],
  ["a second root element", "<Key>a</Key><Key>b</Key>"],
  ["text beside the root element", "<Key>a</Key>b"],
  ["an empty document", ""],
  ["a document that is no XML", "502 Bad Gateway"],
  ["an attribute without a value", "<Key attribute>a</Key>"],
])("%s is refused", (_case, document) => {
  expect(() => parseXml(document)).toThrow(XmlSyntaxError);
});

test("an empty element, whitespace and comments read as nothing", () => {
  const root = parseXml(
    "<!-- before -->\n<ListBucketResult>\n  <Prefix/>\n  <Key>a<!-- inside -->b</Key>\n</ListBucketResult>\n",
  );

  expect(root.children.map((child) => [child.name, child.text])).toEqual([
    ["Prefix", ""],
    ["Key", "ab"],
  ]);
});

test("an element holds its attributes by name, and a namespace declaration among them", () => {
  const root = parseXml(
    '<EnumerationResults xmlns="urn:example" ServiceEndpoint="https://example.test/" ContainerName=\'stowage\'><Name Encoded="true">a</Name><Prefix/></EnumerationResults>',
  );

  expect(root.attributes).toEqual({
    xmlns: "urn:example",
    ServiceEndpoint: "https://example.test/",
    ContainerName: "stowage",
  });
  expect(root.children[0]?.attributes).toEqual({ Encoded: "true" });
  expect(root.children[1]?.attributes).toEqual({});
});

test("an attribute value decodes the entities text does", () => {
  const root = parseXml(`<Key note="a&amp;b&#x2F;&quot;" other='&apos;'/>`);

  expect(root.attributes).toEqual({ note: 'a&b/"', other: "'" });
});

// XML 1.0, section 3.3.3: without a DTD every attribute is CDATA, and each whitespace
// character written into its value reads as a space, a line break as one space.
test("a line break or tab inside an attribute value reads as a space", () => {
  expect(parseXml('<Key note="a\tb\nc\r\nd"/>').attributes).toEqual({ note: "a b c d" });
});

test("a reference to a line break inside an attribute value keeps the line break", () => {
  expect(parseXml('<Key note="a&#10;b"/>').attributes).toEqual({ note: "a\nb" });
});

test.each([
  ["an attribute given twice", '<Key a="1" a="2"/>'],
  ["a `<` inside an attribute value", '<Key a="<"/>'],
  ["an attribute value holding an undefined entity", '<Key a="&nbsp;"/>'],
  ["an attribute on a closing tag", '<Key>a</Key a="1">'],
])("%s is refused", (_case, document) => {
  expect(() => parseXml(document)).toThrow(XmlSyntaxError);
});

test("`XmlSyntaxError` names itself", () => {
  expect(() => parseXml("")).toThrow(expect.objectContaining({ name: "XmlSyntaxError" }));
});
