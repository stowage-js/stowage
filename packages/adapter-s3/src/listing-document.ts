import type { ObjectEntry, StorageError } from "@stowage/core";

import { textOf } from "./answer-document.ts";
import { unquotedEtag } from "./description.ts";
import { s3Error } from "./storage-error.ts";
import { parseXml, type XmlElement, XmlSyntaxError } from "./xml.ts";

/** The response a listing document came in, which a failure to read it is told against. */
export interface ListingAnswer {
  readonly bucket: string;
  /** The operation the caller invoked, which lists on its own for `deleteAll`. */
  readonly operation: string;
  readonly status: number;
  readonly requestId?: string;
}

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
export function readListingDocument(answer: ListingAnswer, body: string): ListingDocument {
  const root = parse(answer, body);

  if (root.name !== "ListBucketResult") {
    throw malformed(answer, `a <${root.name}> where a <ListBucketResult> belongs`);
  }

  return {
    objects: childrenNamed(root, "Contents").map((entry) => readEntry(answer, entry)),
    prefixes: childrenNamed(root, "CommonPrefixes").map((prefix) => {
      const text = textOf(prefix, "Prefix");

      if (text === undefined || text === "") {
        throw malformed(answer, "a pseudo-directory with no prefix");
      }

      return text;
    }),
    continuationToken: continuationOf(answer, root),
  };
}

function parse(answer: ListingAnswer, body: string): XmlElement {
  try {
    return parseXml(body);
  } catch (failure) {
    if (failure instanceof XmlSyntaxError) {
      throw malformed(
        answer,
        `a document outside the XML stowage reads: ${failure.message}`,
        failure,
      );
    }

    throw failure;
  }
}

function readEntry(answer: ListingAnswer, entry: XmlElement): ObjectEntry {
  const key = textOf(entry, "Key");

  if (key === undefined || key === "") throw malformed(answer, "an object with no key");

  const size = sizeOf(textOf(entry, "Size"));

  if (size === undefined) {
    throw malformed(answer, `the object under ${JSON.stringify(key)} with no size`);
  }

  const lastModified = Date.parse(textOf(entry, "LastModified") ?? "");

  if (Number.isNaN(lastModified)) {
    throw malformed(answer, `the object under ${JSON.stringify(key)} with no last-modified time`);
  }

  return { key, size, lastModified: new Date(lastModified), etag: etagOf(textOf(entry, "ETag")) };
}

const decimalDigits = /^\d+$/u;

function sizeOf(text: string | undefined): number | undefined {
  if (text === undefined || !decimalDigits.test(text)) return undefined;

  const size = Number(text);

  return Number.isSafeInteger(size) ? size : undefined;
}

function etagOf(text: string | undefined): string | undefined {
  if (text === undefined || text === "") return undefined;

  return unquotedEtag(text);
}

/**
 * The token the next page continues from. A listing the provider calls truncated and
 * hands no token for would end early without a word, so that is malformed too.
 */
function continuationOf(answer: ListingAnswer, root: XmlElement): string | undefined {
  const truncated = textOf(root, "IsTruncated");

  if (truncated === "false") return undefined;

  if (truncated !== "true") throw malformed(answer, "no word on whether the listing is complete");

  const token = textOf(root, "NextContinuationToken");

  if (token === undefined || token === "") {
    throw malformed(answer, "a listing it calls incomplete and no position to continue from");
  }

  return token;
}

function childrenNamed(element: XmlElement, name: string): readonly XmlElement[] {
  return element.children.filter((child) => child.name === name);
}

function malformed(answer: ListingAnswer, what: string, cause?: unknown): StorageError {
  return s3Error(answer.bucket, {
    code: "ProviderError",
    message: `The provider answered the listing with ${what}`,
    operation: answer.operation,
    attempts: 1,
    status: answer.status,
    requestId: answer.requestId,
    cause,
  });
}
