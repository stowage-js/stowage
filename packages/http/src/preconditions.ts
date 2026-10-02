import type { ObjectStat } from "@stowage/core";

import { httpDateOf, lastModifiedOf } from "./http-date.ts";

/** The preconditions of one request, `undefined` where a field is absent or ignored. */
export interface Preconditions {
  readonly ifMatch?: string;
  readonly ifUnmodifiedSince?: number;
  readonly ifNoneMatch?: string;
  readonly ifModifiedSince?: number;
}

/** The status of a failed precondition, which answers the request in place of the object. */
export type FailedPrecondition = 304 | 412;

export const isFailedPrecondition = (status: number): status is FailedPrecondition =>
  status === 304 || status === 412;

/**
 * The preconditions a request carries, `undefined` where it carries none. A date that is
 * no single HTTP-date is ignored, as RFC 9110 13.1.3 and 13.1.4 have it.
 */
export function preconditionsOf(headers: Headers): Preconditions | undefined {
  const dateOf = (name: string): number | undefined => {
    const field = headers.get(name);

    return field === null ? undefined : httpDateOf(field);
  };
  const preconditions = {
    ifMatch: headers.get("if-match") ?? undefined,
    ifUnmodifiedSince: dateOf("if-unmodified-since"),
    ifNoneMatch: headers.get("if-none-match") ?? undefined,
    ifModifiedSince: dateOf("if-modified-since"),
  };

  return Object.values(preconditions).some((field) => field !== undefined)
    ? preconditions
    : undefined;
}

/**
 * RFC 9110 13.2.2, in its order, against the `stat` of the object the answer would describe:
 * the status of the precondition that fails, `undefined` where every one holds.
 */
export function failedPreconditionOf(
  preconditions: Preconditions | undefined,
  stat: ObjectStat,
  answeredAt: number,
): FailedPrecondition | undefined {
  if (preconditions === undefined) return undefined;

  const { ifMatch, ifUnmodifiedSince, ifNoneMatch, ifModifiedSince } = preconditions;
  // Spec 10.3: dates compare with the `Last-Modified` the answer carries.
  const modified = lastModifiedOf(stat, answeredAt).getTime();

  if (ifMatch === undefined) {
    if (ifUnmodifiedSince !== undefined && modified > ifUnmodifiedSince) return 412;
  } else if (!matches(ifMatch, stat, "strong")) {
    return 412;
  }

  if (ifNoneMatch === undefined) {
    if (ifModifiedSince !== undefined && modified <= ifModifiedSince) return 304;
  } else if (matches(ifNoneMatch, stat, "weak")) {
    return 304;
  }

  return undefined;
}

/**
 * RFC 9110 13.1.5: whether a range may be served under `If-Range`, which only the strong
 * `ETag` lets through. A date never does: at second resolution it is no strong validator.
 */
export function rangeHolds(ifRange: string | undefined, stat: ObjectStat): boolean {
  if (ifRange === undefined) return true;

  const [, weak, opaque] = singleTag.exec(ifRange) ?? [];

  return opaque !== undefined && weak === undefined && opaque === stat.etag;
}

interface EntityTag {
  readonly weak: boolean;
  readonly opaque: string;
}

/**
 * Whether a field of entity tags names the object, `*` naming any. The layer sends the
 * `etag` as a strong tag, so a strong comparison only refuses a weak tag in the field.
 */
function matches(field: string, { etag }: ObjectStat, comparison: "strong" | "weak"): boolean {
  if (field === "*") return true;

  return tagsOf(field).some((tag) => tag.opaque === etag && (comparison === "weak" || !tag.weak));
}

// RFC 9110 8.8.3: `W/` is case-sensitive, and a tag holds any visible character but `"`,
// a comma among them, so a list is split by its quotes and not at its commas.
const entityTag = String.raw`(W\/)?"([\x21\x23-\x7e\x80-\xff]*)"`;
const listMember = new RegExp(String.raw`[ \t]*(?:${entityTag})?[ \t]*(?:,|$)`, "uy");
// RFC 9110 13.1.5: `If-Range` names one tag, not a list.
const singleTag = new RegExp(`^${entityTag}$`, "u");

/** The tags a list names, none for a field that is no list of entity tags. */
function tagsOf(field: string): readonly EntityTag[] {
  const member = new RegExp(listMember);
  const tags: EntityTag[] = [];

  while (member.lastIndex < field.length) {
    const found = member.exec(field);

    if (found === null) return [];

    const [, weak, opaque] = found;

    if (opaque !== undefined) tags.push({ weak: weak !== undefined, opaque });
  }

  return tags;
}
