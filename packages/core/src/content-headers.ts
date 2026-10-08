import type { CapabilityName } from "./capabilities.ts";
import type { Refusal } from "./errors.ts";

/** `Cache-Control`, `Content-Disposition` and `Content-Language`, as `put` carries them. */
export interface ContentHeaders {
  readonly cacheControl?: string;
  readonly contentDisposition?: string;
  readonly contentLanguage?: string;
}

/**
 * RFC 9110 5.5's `field-value` without `obs-text`. A runtime's `fetch` refuses CR, LF, NUL and
 * anything above U+00FF, and trims the whitespace around a value, so a provider would store
 * something other than what the caller wrote (ADR 0058).
 */
const headerValuePattern = /^[\x21-\x7E](?:[\x20-\x7E\t]*[\x21-\x7E])?$/u;

/** Visible ASCII, with spaces and tabs inside alone: the rule of spec 4.3 for a header value. */
export function isHeaderValue(value: string): boolean {
  return headerValuePattern.test(value);
}

/** Each option beside the header it is stored as, in the order spec 4.3 reads them. */
const headerNames: Readonly<Record<keyof ContentHeaders, string>> = {
  cacheControl: "Cache-Control",
  contentDisposition: "Content-Disposition",
  contentLanguage: "Content-Language",
};

/**
 * AWS gives the names and values of its system metadata 2,048 bytes together, `Content-Type`
 * included, and GCS holds a `Content-Language` of at most 100 characters (ADR 0058).
 */
const headerByteLimit = 2048;
const contentLanguageLimit = 100;

/** What AWS counts for a `put` without `Content-Type`, which stores this default. */
const defaultContentType = "application/octet-stream";

const utf8 = new TextEncoder();

export type ContentHeadersCheck = { readonly held: ContentHeaders } | { readonly refusal: Refusal };

/**
 * The content headers a storage holds, or the first check of spec 4.3 they fail, in its order.
 * The checks read a frozen snapshot that reads each option once, so what passed is what an
 * adapter sends. A `put` carrying none of the three as a value other than `undefined` is not
 * measured at all, so a long `contentType` a storage accepted before stays accepted (ADR 0058).
 */
export function checkContentHeaders(
  headers: ContentHeaders,
  contentType: string | undefined,
  capabilities: readonly CapabilityName[],
): ContentHeadersCheck {
  const { cacheControl, contentDisposition, contentLanguage } = headers;
  const held: ContentHeaders = Object.freeze({
    ...(cacheControl === undefined ? {} : { cacheControl }),
    ...(contentDisposition === undefined ? {} : { contentDisposition }),
    ...(contentLanguage === undefined ? {} : { contentLanguage }),
  });
  const refusal = refusalOf(held, contentType, capabilities);

  return refusal === undefined ? { held } : { refusal };
}

function refusalOf(
  headers: ContentHeaders,
  contentType: string | undefined,
  capabilities: readonly CapabilityName[],
): Refusal | undefined {
  const carried = Object.entries(headerNames).filter(
    ([option]) => Reflect.get(headers, option) !== undefined,
  );

  if (carried.length === 0) return undefined;

  // ADR 0060: what a storage cannot hold it does not check, `""` included.
  if (!capabilities.includes("contentHeaders")) {
    return {
      code: "Unsupported",
      message: "This storage holds no content headers",
      capability: "contentHeaders",
    };
  }

  const values: string[] = [];

  for (const [option] of carried) {
    const value: unknown = Reflect.get(headers, option);

    // The message names the option and never the value it refused (spec 4.3).
    if (typeof value !== "string" || !isHeaderValue(value)) {
      return {
        code: "InvalidOption",
        message: `The option \`${option}\` takes a header value: visible ASCII, with spaces and tabs inside alone`,
      };
    }

    values.push(value);
  }

  const headerBytes = [
    "Content-Type",
    contentType ?? defaultContentType,
    ...carried.map(([, name]) => name),
    ...values,
  ].reduce((sum, text) => sum + utf8.encode(text).length, 0);

  if (headerBytes > headerByteLimit) {
    return {
      code: "InvalidRequest",
      message: `The content headers and the content type are ${headerBytes} header bytes, above the limit of ${headerByteLimit}`,
    };
  }

  const contentLanguage = headers.contentLanguage ?? "";

  if (contentLanguage.length > contentLanguageLimit) {
    return {
      code: "InvalidRequest",
      message: `The option \`contentLanguage\` is ${contentLanguage.length} characters, above the limit of ${contentLanguageLimit}`,
    };
  }

  return undefined;
}
