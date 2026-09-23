import type { DeleteReport, StorageError } from "@stowage/core";

import type { S3Configuration } from "./configuration.ts";
import { keyError } from "./key.ts";
import { maxPageSize, walkPages } from "./listing.ts";
import { md5Base64 } from "./md5.ts";
import { readEmbeddedFailure } from "./provider-code.ts";
import { send } from "./request.ts";
import { s3Error } from "./storage-error.ts";
import { parseXml, type XmlElement, XmlSyntaxError } from "./xml.ts";

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
  const document = await readResult(configuration.bucket, batch.operation, response, requestId);

  return document.children
    .filter((child) => child.name === "Error")
    .map((entry) => keyFailure(configuration.bucket, batch.operation, entry, requestId));
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

async function readResult(
  bucket: string,
  operation: string,
  response: Response,
  requestId: string | undefined,
): Promise<XmlElement> {
  const malformed = (what: string, cause?: unknown): StorageError =>
    s3Error(bucket, {
      code: "ProviderError",
      message: `The provider answered the deletion with ${what}`,
      operation,
      attempts: 1,
      status: response.status,
      requestId,
      cause,
    });
  let root: XmlElement;

  try {
    root = parseXml(await response.text());
  } catch (failure) {
    if (failure instanceof XmlSyntaxError) {
      throw malformed(`a document outside the XML stowage reads: ${failure.message}`, failure);
    }

    // Spec 4.10: the caller's abort travels on as the runtime's `AbortError`.
    if (failure instanceof Error && failure.name === "AbortError") throw failure;

    throw s3Error(bucket, {
      code: "NetworkError",
      message: `The answer to the deletion broke while it was read: ${String(failure)}`,
      operation,
      attempts: 1,
      status: response.status,
      requestId,
      retryable: true,
      cause: failure,
    });
  }

  if (root.name !== "DeleteResult") {
    throw malformed(`a <${root.name}> where a <DeleteResult> belongs`);
  }

  return root;
}

function keyFailure(
  bucket: string,
  operation: string,
  entry: XmlElement,
  requestId: string | undefined,
): StorageError {
  const key = textOf(entry, "Key");
  const providerCode = textOf(entry, "Code") ?? "";
  const failure = readEmbeddedFailure(
    providerCode,
    textOf(entry, "Message") ?? `The provider did not delete the key: ${providerCode}`,
  );

  return s3Error(bucket, {
    code: failure.code,
    message: failure.message,
    operation,
    key,
    attempts: 1,
    providerCode: providerCode === "" ? undefined : providerCode,
    requestId,
    retryable: failure.retryable,
  });
}

function textOf(element: XmlElement, name: string): string | undefined {
  return element.children.find((child) => child.name === name)?.text;
}
