import type { ObjectEntry, StorageError } from "@stowage/core";

import { s3Error } from "./storage-error.ts";
import { parseXml, type XmlElement, XmlSyntaxError } from "./xml.ts";

/** One page of a `ListObjectsV2` answer. */
export interface ListingDocument {
  readonly objects: readonly ObjectEntry[];
  readonly prefixes: readonly string[];
  /** The provider's own position, set where the listing goes on past this page. */
  readonly continuationToken?: string;
}

/**
 * What the provider listed, read through the parser of ADR 0003. Spec 4.6 makes an entry
 * that arrives without a key, a size or a last-modified time a `ProviderError`, and
 * spec 7.4 a document outside the subset the parser reads; both leave the page unread
 * rather than hand the caller a value made up for what was missing.
 */
export function readListingDocument(bucket: string, body: string): ListingDocument {
  const root = parse(bucket, body);

  if (root.name !== "ListBucketResult") {
    throw malformed(bucket, `a <${root.name}> where a <ListBucketResult> belongs`);
  }

  return {
    objects: childrenNamed(root, "Contents").map((entry) => readEntry(bucket, entry)),
    prefixes: childrenNamed(root, "CommonPrefixes").map((prefix) => {
      const text = textOf(prefix, "Prefix");

      if (text === undefined || text === "") {
        throw malformed(bucket, "a pseudo-directory with no prefix");
      }

      return text;
    }),
    continuationToken: continuationOf(bucket, root),
  };
}

function parse(bucket: string, body: string): XmlElement {
  try {
    return parseXml(body);
  } catch (failure) {
    if (failure instanceof XmlSyntaxError) {
      throw malformed(
        bucket,
        `a document outside the XML stowage reads: ${failure.message}`,
        failure,
      );
    }

    throw failure;
  }
}

function readEntry(bucket: string, entry: XmlElement): ObjectEntry {
  const key = textOf(entry, "Key");

  if (key === undefined || key === "") throw malformed(bucket, "an object with no key");

  const size = sizeOf(textOf(entry, "Size"));

  if (size === undefined) {
    throw malformed(bucket, `the object under ${JSON.stringify(key)} with no size`);
  }

  const lastModified = Date.parse(textOf(entry, "LastModified") ?? "");

  if (Number.isNaN(lastModified)) {
    throw malformed(bucket, `the object under ${JSON.stringify(key)} with no last-modified time`);
  }

  return { key, size, lastModified: new Date(lastModified), etag: etagOf(textOf(entry, "ETag")) };
}

const decimalDigits = /^\d+$/u;

function sizeOf(text: string | undefined): number | undefined {
  if (text === undefined || !decimalDigits.test(text)) return undefined;

  const size = Number(text);

  return Number.isSafeInteger(size) ? size : undefined;
}

// The quotes belong to the XML S3 writes rather than to the value, which spec 4.4 leaves
// opaque; stripping them is what makes a listing answer the string `stat` answers.
function etagOf(text: string | undefined): string | undefined {
  if (text === undefined || text === "") return undefined;

  return text.replace(/^"|"$/gu, "");
}

/**
 * The token the next page continues from. A listing the provider calls truncated and
 * hands no token for would end early without a word, so that is malformed too.
 */
function continuationOf(bucket: string, root: XmlElement): string | undefined {
  const truncated = textOf(root, "IsTruncated");

  if (truncated === "false") return undefined;

  if (truncated !== "true") throw malformed(bucket, "no word on whether the listing is complete");

  const token = textOf(root, "NextContinuationToken");

  if (token === undefined || token === "") {
    throw malformed(bucket, "a listing it calls incomplete and no position to continue from");
  }

  return token;
}

function childrenNamed(element: XmlElement, name: string): readonly XmlElement[] {
  return element.children.filter((child) => child.name === name);
}

function textOf(element: XmlElement, name: string): string | undefined {
  return element.children.find((child) => child.name === name)?.text;
}

function malformed(bucket: string, what: string, cause?: unknown): StorageError {
  return s3Error(bucket, {
    code: "ProviderError",
    message: `The provider answered the listing with ${what}`,
    operation: "list",
    attempts: 1,
    cause,
  });
}
