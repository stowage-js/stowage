import {
  type CapabilityName,
  capabilityNames,
  type Precondition,
  preconditionRefusal,
} from "@stowage/core";

import { httpDateOf } from "./http-date.ts";
import { type EntityTag, entityTagsOf } from "./preconditions.ts";

/**
 * The `onlyIf` that `put` gets for every precondition of an upload, or the status that
 * answers the request without `put` where none can.
 */
export type UploadPrecondition =
  | { readonly onlyIf: Precondition | undefined }
  | { readonly refusal: 400 | 412 | 501 };

/** A field of entity tags as the request carries it. */
type TagField = "absent" | "*" | readonly EntityTag[] | "malformed";

/**
 * Spec 10.5: the one `onlyIf` that satisfies the caller's `onlyIf` and the request's
 * `If-Match` and `If-None-Match`, read in the order of RFC 9110 13.2.2. A malformed field or
 * option is `400`, a field no `onlyIf` expresses or `capabilities` holds `501`, and
 * preconditions that cannot hold together `412`, in that order (ADR 0075).
 */
export function uploadPreconditionOf(
  headers: Headers,
  onlyIf: Precondition | undefined,
  capabilities: readonly CapabilityName[],
): UploadPrecondition {
  const ifMatch = tagFieldOf(headers.get("if-match"));
  const ifNoneMatch = tagFieldOf(headers.get("if-none-match"));

  // Every capability is assumed for the caller's `onlyIf`, so that only its form is refused
  // here: a storage that holds no precondition is the caller's, and `put` refuses it.
  if (preconditionRefusal(onlyIf, "write", capabilityNames) !== undefined) return { refusal: 400 };
  // ADR 0075: where `serveObject` reads such a field as naming nothing, a write would
  // overwrite what the client meant to protect.
  if (ifMatch === "malformed" || ifNoneMatch === "malformed") return { refusal: 400 };

  const callerEtag = typeof onlyIf === "object" ? onlyIf.etag : undefined;
  const etags = typeof ifMatch === "string" ? undefined : namedEtags(ifMatch);
  const absent = ifNoneMatch === "*";
  // RFC 9110 13.2.2 evaluates `If-Unmodified-Since` only without `If-Match`.
  const unmodifiedSince =
    ifMatch === "absent" && httpDateOf(headers.get("if-unmodified-since") ?? "") !== undefined;
  // Holding these would take a `stat` in front of the write, the race a precondition exists
  // to close, and dropping them would write where the client asked not to (ADR 0075).
  const inexpressible =
    (callerEtag === undefined && (ifMatch === "*" || (etags?.size ?? 0) > 1)) ||
    (Array.isArray(ifNoneMatch) && ifNoneMatch.length > 0) ||
    unmodifiedSince;
  // Read before the body, since `put` refusing it as `Unsupported` would answer `500` to a
  // value the client chose.
  const unsupported =
    (absent && !capabilities.includes("writeIfAbsent")) ||
    (ifMatch !== "absent" && !capabilities.includes("writeIfUnchanged"));

  if (inexpressible || unsupported) return { refusal: 501 };

  if (absent || onlyIf === "absent") {
    const contradicted = ifMatch !== "absent" || callerEtag !== undefined;

    return contradicted ? { refusal: 412 } : { onlyIf: "absent" };
  }

  if (etags === undefined) return { onlyIf };
  if (callerEtag !== undefined) return etags.has(callerEtag) ? { onlyIf } : { refusal: 412 };

  const [etag] = etags;

  return etag === undefined ? { refusal: 412 } : { onlyIf: { etag } };
}

function tagFieldOf(field: string | null): TagField {
  if (field === null) return "absent";
  if (field === "*") return "*";

  return entityTagsOf(field) ?? "malformed";
}

/**
 * The distinct `etag`s an `If-Match` can name. A weak tag never matches under the strong
 * comparison of RFC 9110 8.8.3.2, and a tag outside the form of an `etag` in `onlyIf`, such
 * as `""`, names no object any storage hands over.
 */
function namedEtags(tags: readonly EntityTag[]): ReadonlySet<string> {
  return new Set(tags.filter((tag) => !tag.weak && isEtag(tag.opaque)).map((tag) => tag.opaque));
}

const isEtag = (opaque: string): boolean =>
  preconditionRefusal({ etag: opaque }, "write", capabilityNames) === undefined;
