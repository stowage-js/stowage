import { type ObjectEntry, parseXml, type XmlElement, XmlSyntaxError } from "@stowage/core";

import { type AnsweredRequest, malformedAnswer } from "./answer.ts";
import { unquotedEtag } from "./description.ts";

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
export function readListingDocument(answered: AnsweredRequest, body: string): ListingDocument {
  const root = parse(answered, body);

  if (root.name !== "EnumerationResults") {
    throw malformedAnswer(answered, `a <${root.name}> where an <EnumerationResults> belongs`);
  }

  const listed = childrenNamed(root, "Blobs").flatMap((blobs) => blobs.children);

  return {
    objects: listed
      .filter((child) => child.name === "Blob")
      .map((entry) => readEntry(answered, entry)),
    prefixes: listed
      .filter((child) => child.name === "BlobPrefix")
      .map((prefix) => {
        const name = nameOf(answered, prefix);

        if (name === undefined) throw malformedAnswer(answered, "a pseudo-directory with no name");

        return name;
      }),
    nextMarker: nextMarkerOf(root),
  };
}

function parse(answered: AnsweredRequest, body: string): XmlElement {
  try {
    return parseXml(body);
  } catch (failure) {
    if (failure instanceof XmlSyntaxError) {
      throw malformedAnswer(
        answered,
        `a document outside the XML stowage reads: ${failure.message}`,
        failure,
      );
    }

    throw failure;
  }
}

function readEntry(answered: AnsweredRequest, entry: XmlElement): ObjectEntry {
  const key = nameOf(answered, entry);

  if (key === undefined) throw malformedAnswer(answered, "an object with no key");

  const properties = childrenNamed(entry, "Properties")[0];
  const size = sizeOf(textOf(properties, "Content-Length"));

  if (size === undefined) {
    throw malformedAnswer(answered, `the object under ${JSON.stringify(key)} with no size`);
  }

  const lastModified = Date.parse(textOf(properties, "Last-Modified") ?? "");

  if (Number.isNaN(lastModified)) {
    throw malformedAnswer(
      answered,
      `the object under ${JSON.stringify(key)} with no last-modified time`,
    );
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
function nameOf(answered: AnsweredRequest, element: XmlElement): string | undefined {
  const name = element.children.find((child) => child.name === "Name");

  if (name === undefined || name.text === "") return undefined;

  if (name.attributes["Encoded"] !== "true") return name.text;

  try {
    return decodeURIComponent(name.text);
  } catch (failure) {
    if (!(failure instanceof URIError)) throw failure;

    throw malformedAnswer(
      answered,
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
