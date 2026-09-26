import {
  type ObjectEntry,
  parseXml,
  type StorageError,
  type XmlElement,
  XmlSyntaxError,
} from "@stowage/core";

import { unquotedEtag } from "./description.ts";
import { azureBlobError } from "./storage-error.ts";

/** The response a listing document came in, which a failure to read it is told against. */
export interface ListingAnswer {
  readonly container: string;
  readonly operation: string;
  readonly status: number;
  readonly requestId?: string;
}

/** One page of a `List Blobs` answer. */
export interface ListingDocument {
  readonly objects: readonly ObjectEntry[];
  readonly prefixes: readonly string[];
  /** The provider's own position, set where the listing goes on past this page. */
  readonly nextMarker?: string;
}

/**
 * What the provider listed, read through the parser of spec 8.4. Spec 4.6 makes an entry
 * that arrives without a key, a size or a last-modified time a `ProviderError`, and so is
 * a document outside the subset the parser reads; both leave the page unread rather than
 * hand the caller a value made up for what was missing.
 */
export function readListingDocument(answer: ListingAnswer, body: string): ListingDocument {
  const root = parse(answer, body);

  if (root.name !== "EnumerationResults") {
    throw malformed(answer, `a <${root.name}> where an <EnumerationResults> belongs`);
  }

  const listed = childrenNamed(root, "Blobs").flatMap((blobs) => blobs.children);

  return {
    objects: listed
      .filter((child) => child.name === "Blob")
      .map((entry) => readEntry(answer, entry)),
    prefixes: listed
      .filter((child) => child.name === "BlobPrefix")
      .map((prefix) => {
        const name = nameOf(answer, prefix);

        if (name === undefined) throw malformed(answer, "a pseudo-directory with no name");

        return name;
      }),
    nextMarker: nextMarkerOf(root),
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
  const key = nameOf(answer, entry);

  if (key === undefined) throw malformed(answer, "an object with no key");

  const properties = childrenNamed(entry, "Properties")[0];
  const size = sizeOf(textOf(properties, "Content-Length"));

  if (size === undefined) {
    throw malformed(answer, `the object under ${JSON.stringify(key)} with no size`);
  }

  const lastModified = Date.parse(textOf(properties, "Last-Modified") ?? "");

  if (Number.isNaN(lastModified)) {
    throw malformed(answer, `the object under ${JSON.stringify(key)} with no last-modified time`);
  }

  return {
    key,
    size,
    lastModified: new Date(lastModified),
    etag: etagOf(textOf(properties, "Etag")),
  };
}

/**
 * Spec 8.4: Azure carries a name holding a character XML cannot, `U+FFFE` or `U+FFFF`, as
 * percent-encoded UTF-8 under `Encoded="true"`, and every other name as it stands.
 */
function nameOf(answer: ListingAnswer, element: XmlElement): string | undefined {
  const name = element.children.find((child) => child.name === "Name");

  if (name === undefined || name.text === "") return undefined;

  if (name.attributes["Encoded"] !== "true") return name.text;

  try {
    return decodeURIComponent(name.text);
  } catch (failure) {
    if (!(failure instanceof URIError)) throw failure;

    throw malformed(
      answer,
      `the name ${JSON.stringify(name.text)}, which does not decode`,
      failure,
    );
  }
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

/** Azure ends a listing with an empty `NextMarker`, and one of text continues it. */
function nextMarkerOf(root: XmlElement): string | undefined {
  const marker = textOf(root, "NextMarker");

  return marker === undefined || marker === "" ? undefined : marker;
}

function textOf(element: XmlElement | undefined, name: string): string | undefined {
  return element?.children.find((child) => child.name === name)?.text;
}

function childrenNamed(element: XmlElement, name: string): readonly XmlElement[] {
  return element.children.filter((child) => child.name === name);
}

function malformed(answer: ListingAnswer, what: string, cause?: unknown): StorageError {
  return azureBlobError(answer.container, {
    code: "ProviderError",
    message: `The provider answered the listing with ${what}`,
    operation: answer.operation,
    attempts: 1,
    status: answer.status,
    requestId: answer.requestId,
    cause,
  });
}
