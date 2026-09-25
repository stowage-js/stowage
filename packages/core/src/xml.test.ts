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
  ["a reference to a surrogate", "<Key>&#xD800;</Key>"],
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

test("`XmlSyntaxError` names itself", () => {
  expect(() => parseXml("")).toThrow(expect.objectContaining({ name: "XmlSyntaxError" }));
});
