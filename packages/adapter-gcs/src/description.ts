import type { ObjectStat } from "@stowage/core";

import { type AnsweredRequest, malformedAnswer, readAnswerJson } from "./answer.ts";
import { fieldOf } from "./json.ts";

export const defaultContentType = "application/octet-stream";

/** Until the storage reads `metadata` off the resource, every object reads as holding none. */
const noUserMetadata: Readonly<Record<string, string>> = Object.freeze(Object.create(null));

/** A decimal count of bytes, which the JSON API sends as a string to keep 64 bits whole. */
const decimalSize = /^(?:0|[1-9]\d*)$/u;

/** The object resource the JSON API answers a metadata read and an upload with, read to the end. */
export async function readResource(
  bucket: string,
  key: string,
  operation: string,
  response: Response,
): Promise<unknown> {
  return await readAnswerJson(resourceAnswer(bucket, key, operation, response));
}

/**
 * Spec 4.4 out of the object resource: `size`, the time of `updated` and the `etag`. The
 * key is the one the call named, which the resource's `name` repeats byte for byte.
 */
export function describeResource(
  bucket: string,
  key: string,
  operation: string,
  response: Response,
  resource: unknown,
): ObjectStat {
  const size = sizeOf(resource);
  const lastModified = lastModifiedOf(resource);
  const contentType = fieldOf(resource, "contentType");
  const answered = resourceAnswer(bucket, key, operation, response);

  if (size === undefined) throw malformedAnswer(answered, "no size");
  if (lastModified === undefined) throw malformedAnswer(answered, "no last-modified time");

  return {
    key,
    size,
    lastModified,
    ...etagOf(resource),
    contentType:
      typeof contentType === "string" && contentType !== "" ? contentType : defaultContentType,
    userMetadata: noUserMetadata,
  };
}

/** The resource's `size`, where it holds a count of bytes. */
export function sizeOf(resource: unknown): number | undefined {
  const size = fieldOf(resource, "size");

  return typeof size === "string" && decimalSize.test(size) ? Number(size) : undefined;
}

/** The time of the resource's `updated`, where it holds one. */
export function lastModifiedOf(resource: unknown): Date | undefined {
  const updated = fieldOf(resource, "updated");
  const modified = typeof updated === "string" ? Date.parse(updated) : Number.NaN;

  return Number.isNaN(modified) ? undefined : new Date(modified);
}

/** The resource's `etag` as the field of a description, which has none where GCS sent none. */
export function etagOf(resource: unknown): { readonly etag?: string } {
  const etag = fieldOf(resource, "etag");

  return typeof etag === "string" && etag !== "" ? { etag } : {};
}

function resourceAnswer(
  bucket: string,
  key: string,
  operation: string,
  response: Response,
): AnsweredRequest {
  return { bucket, operation, key, subject: `the request for ${JSON.stringify(key)}`, response };
}
