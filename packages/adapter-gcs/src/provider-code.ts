import { errorCodeForStatus, type StorageErrorCode } from "@stowage/core";

/**
 * The table of spec 9.8: a provider code recognized here decides the error code alone, and
 * an unrecognized one falls to the status mapping of spec 4.10. Whether the condition is
 * transient is never read from here — ADR 0013 decides that by the status, so that an
 * unknown `5xx` is treated no worse than one stowage has heard of.
 */
const providerCodes: ReadonlyMap<string, StorageErrorCode> = new Map([
  ["notFound", "NotFound"],
  ["forbidden", "AccessDenied"],
  ["insufficientPermissions", "AccessDenied"],
  // States of the object stowage does not create, which widening the role does not lift
  // although they arrive as `403` (ADR 0038).
  ["objectUnderActiveHold", "ProviderError"],
  ["retentionPolicyNotMet", "ProviderError"],
  ["authError", "InvalidCredentials"],
  ["required", "InvalidCredentials"],
  ["invalidArgument", "InvalidRequest"],
  ["requestedRangeNotSatisfiable", "InvalidRequest"],
  ["uploadTooLarge", "InvalidRequest"],
  ["invalid", "ProviderError"],
  ["conditionNotMet", "ProviderError"],
  ["conflict", "ProviderError"],
  ["clientClosedRequest", "ProviderError"],
]);

const unauthorized = 401;
const notFound = 404;

/** Spec 9.8: what GCS answers on every path where the bucket itself is missing. */
const missingBucketMessage = "The specified bucket does not exist.";

/** What the provider answered a request with, as much of it as spec 9.8 reads. */
export interface ProviderAnswer {
  readonly status: number;
  /** The method, which says what a provider that sent no message answered to. */
  readonly method: string;
  readonly providerCode?: string;
  readonly providerMessage?: string;
  /**
   * Whether the answer came from the media download, the one path that carries no provider
   * code and whose `404` is read by its status (ADR 0038).
   */
  readonly media: boolean;
  /** Whether the request was a listing sent with the page token of the caller's cursor. */
  readonly carriesCursor: boolean;
  /** Whether the request went out under a token the resolver had just refreshed. */
  readonly underRefreshedToken: boolean;
  readonly headers: Headers;
}

export interface ProviderFailure {
  readonly code: StorageErrorCode;
  readonly message: string;
  /** Whether the failure is the bucket's rather than the key's, so that it names no key. */
  readonly ofBucket?: boolean;
}

/**
 * What the provider's answer means, decided by its provider code where the table recognizes
 * one and by the status where it does not. The message is the provider's word for word (spec
 * 4.10), except where spec 9.3 and 9.8 have it say what the caller can act on: a token a
 * refresh did not make acceptable, a path the endpoint does not serve, and a cursor the
 * provider no longer continues from.
 */
export function readProviderFailure(answer: ProviderAnswer): ProviderFailure {
  const said = answer.providerMessage ?? statusMessage(answer);

  if (answer.status === notFound && answer.providerMessage?.trim() === missingBucketMessage) {
    return { code: "NotFound", message: said, ofBucket: true };
  }

  // ADR 0033: an expired token and a forged one answer alike, so the message names both
  // and leaves the caller, who knows what the resolver handed over, to tell them apart.
  if (answer.underRefreshedToken && answer.status === unauthorized) {
    return {
      code: "InvalidCredentials",
      message: `The access token expired or is not accepted, and so is the one the resolver refreshed: ${said}`,
    };
  }

  // ADR 0038: a path the JSON API does not serve answers `404` without a provider code, and read
  // by its status an `endpoint` with a wrong prefix would look like an empty bucket.
  if (answer.status === notFound && !answer.media && answer.providerCode !== "notFound") {
    return {
      code: "ProviderError",
      message: `The endpoint serves no such path, so the answer says nothing about the object: ${said}`,
    };
  }

  // Spec 9.8: GCS refuses a page token it no longer continues from as `invalid`, and the
  // caller handed that token over as the `cursor` of `list`, which is what they can act on.
  if (answer.providerCode === "invalid" && answer.carriesCursor) {
    return {
      code: "InvalidOption",
      message: `The option \`cursor\` is not one the provider continued from: ${said}`,
    };
  }

  const recognized =
    answer.providerCode === undefined ? undefined : providerCodes.get(answer.providerCode);

  return {
    code: recognized ?? errorCodeForStatus(answer.status) ?? "ProviderError",
    message: said,
  };
}

function statusMessage(answer: Pick<ProviderAnswer, "status" | "method">): string {
  return `The provider answered ${answer.status} to \`${answer.method}\``;
}

/**
 * Spec 9.3: the one answer an expired token hides behind, alike on every path, after which
 * the adapter resolves the credential once more with `forceRefresh: true`. RFC 6750 allows
 * the value quoted, and GCS sends it bare.
 */
export function isRefusedToken(answer: Pick<ProviderAnswer, "status" | "headers">): boolean {
  if (answer.status !== unauthorized) return false;

  const challenge = answer.headers.get("www-authenticate") ?? "";

  return /(?:^|[\s,])error\s*=\s*(?:invalid_token|"invalid_token")\s*(?:,|$)/iu.test(challenge);
}

export interface ErrorBody {
  readonly message?: string;
  /** `errors[0].reason`, the name the JSON API gives its provider code. */
  readonly providerCode?: string;
}

/**
 * Spec 9.8: a failure body is JSON whatever its `Content-Type` says, since GCS labels its
 * error documents `text/html` on some paths. A body that is no JSON is the one line of text
 * a media download answers, and a body that starts with `<` is a page of the frontend or an
 * XML document from a path the JSON API does not serve, neither of which is read.
 */
export function readErrorBody(body: string): ErrorBody {
  const trimmed = body.trim();

  if (trimmed === "" || trimmed.startsWith("<")) return {};

  let parsed: unknown;

  try {
    parsed = JSON.parse(trimmed);
  } catch {
    return { message: decodeCharacterReferences(trimmed) };
  }

  const error = fieldOf(parsed, "error");
  const [first] = arrayOf(fieldOf(error, "errors"));

  return {
    message: stringOf(fieldOf(error, "message")),
    providerCode: stringOf(fieldOf(first, "reason")),
  };
}

const characterReference = /&(?:#x([\da-f]+)|#(\d+)|(amp|lt|gt|quot|apos));/giu;

const namedCharacters: ReadonlyMap<string, string> = new Map([
  ["amp", "&"],
  ["lt", "<"],
  ["gt", ">"],
  ["quot", '"'],
  ["apos", "'"],
]);

/**
 * The references GCS escapes a media failure's text with, such as `&#39;` for `'`. A
 * reference that names no character, or a name outside the five of XML, stays as written
 * rather than turning into a character the provider did not say.
 */
function decodeCharacterReferences(text: string): string {
  return text.replace(
    characterReference,
    (reference, hex: string | undefined, decimal: string | undefined, name: string | undefined) => {
      if (name !== undefined) return namedCharacters.get(name) ?? reference;

      const codePoint = hex === undefined ? Number(decimal) : Number.parseInt(hex, 16);

      return isReferableCharacter(codePoint) ? String.fromCodePoint(codePoint) : reference;
    },
  );
}

function isReferableCharacter(codePoint: number): boolean {
  return codePoint > 0 && codePoint <= 0x10_ffff && !(codePoint >= 0xd8_00 && codePoint <= 0xdf_ff);
}

function fieldOf(value: unknown, name: string): unknown {
  return typeof value === "object" && value !== null ? Reflect.get(value, name) : undefined;
}

function arrayOf(value: unknown): readonly unknown[] {
  return Array.isArray(value) ? value : [];
}

function stringOf(value: unknown): string | undefined {
  return typeof value === "string" && value !== "" ? value : undefined;
}
