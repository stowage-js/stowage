import { expect, test } from "vitest";

import { type ListingAnswer, readListingDocument } from "./listing-document.ts";

const answered: ListingAnswer = {
  bucket: "stowage",
  operation: "list",
  status: 200,
  requestId: "abc",
};

/** A `ListObjectsV2` answer as AWS writes it, around the elements a case supplies. */
function answer(inside: string, truncated = false): string {
  return `<?xml version="1.0" encoding="UTF-8"?>
<ListBucketResult xmlns="http://s3.amazonaws.com/doc/2006-03-01/">
  <Name>stowage</Name>
  <Prefix>photos/</Prefix>
  <KeyCount>2</KeyCount>
  <MaxKeys>1000</MaxKeys>
  <Delimiter>/</Delimiter>
  <IsTruncated>${truncated}</IsTruncated>
  ${inside}
</ListBucketResult>`;
}

function contents(key: string, size = "434234"): string {
  return `<Contents><Key>${key}</Key><LastModified>2009-10-12T17:50:30.000Z</LastModified><ETag>&quot;fba9dede5f27731c9771645a39863328&quot;</ETag><Size>${size}</Size><StorageClass>STANDARD</StorageClass></Contents>`;
}

test("it reads the objects, the pseudo-directories and that the listing is complete", () => {
  const document = readListingDocument(
    answered,
    answer(
      `${contents("photos/cat.jpg")}<CommonPrefixes><Prefix>photos/2026/</Prefix></CommonPrefixes>`,
    ),
  );

  expect(document).toEqual({
    objects: [
      {
        key: "photos/cat.jpg",
        size: 434_234,
        lastModified: new Date("2009-10-12T17:50:30.000Z"),
        etag: "fba9dede5f27731c9771645a39863328",
      },
    ],
    prefixes: ["photos/2026/"],
    continuationToken: undefined,
  });
});

test("an incomplete listing hands over the position the provider continues from", () => {
  const document = readListingDocument(
    answered,
    answer(
      `${contents("a")}<NextContinuationToken>1ueGcxLPRx1Tr/XYExHnhbYLgveDs2J/wm36Hy4vbOwM=</NextContinuationToken>`,
      true,
    ),
  );

  expect(document.continuationToken).toBe("1ueGcxLPRx1Tr/XYExHnhbYLgveDs2J/wm36Hy4vbOwM=");
});

// Keys are user controlled and arrive escaped (ADR 0003), and SeaweedFS writes the quotes
// around an entity tag as `&#34;` where S3 writes `&quot;`.
test("a key and an entity tag arrive through their entities", () => {
  const document = readListingDocument(
    answered,
    answer(
      "<Contents><Key>a&amp;b &lt;c&gt; &#39;d&#39;</Key><LastModified>2026-09-23T08:00:00Z</LastModified><ETag>&#34;abc&#34;</ETag><Size>0</Size></Contents>",
    ),
  );

  expect(document.objects[0]?.key).toBe("a&b <c> 'd'");
  expect(document.objects[0]?.etag).toBe("abc");
  expect(document.objects[0]?.size).toBe(0);
});

test("an entry without an entity tag reads as one without", () => {
  const document = readListingDocument(
    answered,
    answer(
      "<Contents><Key>a</Key><LastModified>2026-09-23T08:00:00Z</LastModified><Size>1</Size></Contents>",
    ),
  );

  expect(document.objects[0]?.etag).toBeUndefined();
});

// Spec 4.6: an entry that arrives without one of its three parts is a `ProviderError`
// rather than an entry with a value made up for it.
test.each([
  ["a key", "<Contents><LastModified>2026-09-23T08:00:00Z</LastModified><Size>1</Size></Contents>"],
  [
    "an empty key",
    "<Contents><Key/><LastModified>2026-09-23T08:00:00Z</LastModified><Size>1</Size></Contents>",
  ],
  ["a size", "<Contents><Key>a</Key><LastModified>2026-09-23T08:00:00Z</LastModified></Contents>"],
  [
    "a size that is no count",
    "<Contents><Key>a</Key><LastModified>2026-09-23T08:00:00Z</LastModified><Size>-1</Size></Contents>",
  ],
  ["a last-modified time", "<Contents><Key>a</Key><Size>1</Size></Contents>"],
  [
    "a last-modified time that is no time",
    "<Contents><Key>a</Key><LastModified>yesterday</LastModified><Size>1</Size></Contents>",
  ],
  ["a prefix in a pseudo-directory", "<CommonPrefixes></CommonPrefixes>"],
])("an entry without %s is a `ProviderError`", (_part, inside) => {
  expect(() => readListingDocument(answered, answer(inside))).toThrow(
    expect.objectContaining({
      code: "ProviderError",
      operation: "list",
      bucket: "stowage",
      status: 200,
      requestId: "abc",
    }),
  );
});

test.each([
  ["a CDATA section", answer("<Contents><Key><![CDATA[a]]></Key></Contents>")],
  ["a document that is no XML", "<html><body>502 Bad Gateway</body></html"],
  ["another root element", "<Error><Code>InternalError</Code></Error>"],
  ["no word on completeness", answer("").replace("<IsTruncated>false</IsTruncated>", "")],
  ["a truncated listing without a token", answer("", true)],
])("%s is a `ProviderError`", (_case, body) => {
  expect(() => readListingDocument(answered, body)).toThrow(
    expect.objectContaining({ code: "ProviderError", operation: "list" }),
  );
});
