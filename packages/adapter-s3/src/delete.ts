import type { DeleteReport, StorageError } from "@stowage/core";

import {
  type AnsweredRequest,
  embeddedFailure,
  readAnswerDocument,
  textOf,
} from "./answer-document.ts";
import type { S3Configuration } from "./configuration.ts";
import { keyError } from "./key.ts";
import { maxPageSize, walkPages } from "./listing.ts";
import { md5Base64 } from "./md5.ts";
import { send } from "./request.ts";
import { s3Error } from "./storage-error.ts";
import type { XmlElement } from "./xml.ts";

/** What one `DeleteObjects` names at most, and so what spec 4.1 sends one request per. */
const keysPerRequest = 1000;

const utf8 = new TextEncoder();

interface DeleteBatch {
  /** The operation the caller invoked: `delete`, or `deleteAll` for the page it listed. */
  readonly operation: string;
  readonly signal?: AbortSignal;
}

/**
 * Spec 4.7: every key is reported, the invalid ones as `InvalidKey` without being sent,
 * and a failure of a request as a whole rejects the call instead of filling the report.
 */
export async function deleteKeys(
  configuration: S3Configuration,
  keys: readonly string[],
  batch: DeleteBatch,
): Promise<DeleteReport> {
  const failed: StorageError[] = [];
  const sendable: string[] = [];

  for (const key of keys) {
    const refusal = refusalOf(configuration.bucket, key, batch.operation);

    if (refusal === undefined) sendable.push(key);
    else failed.push(refusal);
  }

  for (let offset = 0; offset < sendable.length; offset += keysPerRequest) {
    const slice = sendable.slice(offset, offset + keysPerRequest);

    // oxlint-disable-next-line no-await-in-loop -- one batch in flight bounds the request rate
    failed.push(...(await deleteBatch(configuration, slice, batch)));
  }

  return { requested: keys.length, failed };
}

/**
 * Spec 4.11: every object below the prefix, listed a page at a time and each page deleted
 * as it arrives, so the call holds one page of keys whatever the prefix holds.
 */
export async function deleteBelow(
  configuration: S3Configuration,
  prefix: string,
  signal: AbortSignal | undefined,
): Promise<DeleteReport> {
  const operation = "deleteAll";
  const failed: StorageError[] = [];
  let requested = 0;

  for await (const page of walkPages(configuration, {
    operation,
    prefix,
    pageSize: maxPageSize,
    signal,
  })) {
    const report = await deleteKeys(
      configuration,
      page.objects.map((entry) => entry.key),
      { operation, signal },
    );

    requested += report.requested;
    failed.push(...report.failed);
  }

  return { requested, failed };
}

function refusalOf(bucket: string, key: string, operation: string): StorageError | undefined {
  const invalid = keyError(bucket, key, "addressable", operation);

  if (invalid !== undefined) return invalid;

  // A lone surrogate has no UTF-8 form, and the encoder would send U+FFFD in its place:
  // a request that deletes another object than the one the caller named.
  if (key.isWellFormed()) return undefined;

  return s3Error(bucket, {
    code: "InvalidKey",
    message: `The key ${JSON.stringify(key)} holds a lone surrogate, which has no UTF-8 form`,
    operation,
    key,
    attempts: 0,
  });
}

async function deleteBatch(
  configuration: S3Configuration,
  keys: readonly string[],
  batch: DeleteBatch,
): Promise<readonly StorageError[]> {
  if (keys.length === 0) return [];

  batch.signal?.throwIfAborted();

  const body = utf8.encode(deleteDocument(keys));
  const response = await send(configuration, {
    method: "POST",
    operation: batch.operation,
    query: [["delete", ""]],
    headers: [
      ["content-type", "application/xml"],
      // ADR 0009 sends no `x-amz-checksum-*`, and AWS refuses a `DeleteObjects` that
      // carries neither that nor `Content-MD5`.
      ["content-md5", md5Base64(body)],
    ],
    body,
    signal: batch.signal,
  });
  const requestId = response.headers.get("x-amz-request-id") ?? undefined;
  const answered: AnsweredRequest = {
    bucket: configuration.bucket,
    operation: batch.operation,
    subject: "the deletion",
  };
  const document = await readAnswerDocument(answered, response, "DeleteResult");

  return document.children
    .filter((child) => child.name === "Error")
    .map((entry) => keyFailure(answered, entry, requestId));
}

/** `Quiet` has the provider answer with the keys it failed alone. */
function deleteDocument(keys: readonly string[]): string {
  const objects = keys.map((key) => `<Object><Key>${escapeXml(key)}</Key></Object>`).join("");

  return `<?xml version="1.0" encoding="UTF-8"?><Delete><Quiet>true</Quiet>${objects}</Delete>`;
}

const xmlEscapes: Readonly<Record<string, string>> = {
  "&": "&amp;",
  "<": "&lt;",
  ">": "&gt;",
  '"': "&quot;",
  "'": "&apos;",
};

function escapeXml(text: string): string {
  return text.replaceAll(/[&<>"']/gu, (character) => xmlEscapes[character] ?? character);
}

/**
 * One key the provider failed, told as the answer's failure is, without the `200` that
 * spoke for the whole request. Spec 4.7 has every entry carry its key, so an entry the
 * provider names no key for leaves the answer unread rather than reported keyless.
 */
function keyFailure(
  request: AnsweredRequest,
  entry: XmlElement,
  requestId: string | undefined,
): StorageError {
  const key = textOf(entry, "Key");

  if (key === undefined || key === "") {
    throw s3Error(request.bucket, {
      code: "ProviderError",
      message: `The provider answered ${request.subject} with a failed key it did not name`,
      operation: request.operation,
      attempts: 1,
      requestId,
    });
  }

  return embeddedFailure(
    request,
    { operation: request.operation, key, attempts: 1, requestId },
    entry,
  );
}
