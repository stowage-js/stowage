import {
  batchBody,
  batchBoundary,
  batchContentType,
  type BatchSubresponse,
  type DeleteReport,
  readSubresponses,
  type StorageError,
  type SubresponseReading,
} from "@stowage/core";

import { type AnsweredRequest, malformedAnswer, readAnswerText } from "./answer.ts";
import type { GcsConfiguration } from "./configuration.ts";
import { keyRefusal } from "./key.ts";
import { maxPageSize, walkPages } from "./listing.ts";
import { providerError, readErrorBody } from "./provider-code.ts";
import { batchPath, objectPath, requestIdHeader, send } from "./request.ts";

/** What one batch carries at most, and so what spec 9.1 sends one request per. */
const subrequestsPerBatch = 100;

/** GCS answers a subrequest sent as `0` under `<response-0>`. */
const inResponseBrackets = (contentId: string) => `<response-${contentId}>`;

/** fake-gcs-server answers it under `0`, as sent. */
const echoedAsSent = (contentId: string) => contentId;

interface DeleteCall {
  /** The operation the caller invoked: `delete`, or `deleteAll` for the page it listed. */
  readonly operation: string;
  readonly signal?: AbortSignal;
}

/**
 * Spec 4.7: every key is reported, the invalid ones as `InvalidKey` without being sent,
 * and a failure of a batch as a whole rejects the call instead of filling the report.
 */
export async function deleteKeys(
  configuration: GcsConfiguration,
  keys: readonly string[],
  call: DeleteCall,
): Promise<DeleteReport> {
  const failed: StorageError[] = [];
  const sendable: string[] = [];

  for (const key of keys) {
    const refusal = keyRefusal(configuration.bucket, key, "addressable", call.operation);

    if (refusal === undefined) sendable.push(key);
    else failed.push(refusal);
  }

  for (let offset = 0; offset < sendable.length; offset += subrequestsPerBatch) {
    const slice = sendable.slice(offset, offset + subrequestsPerBatch);

    // oxlint-disable-next-line no-await-in-loop -- one batch in flight bounds the request rate
    failed.push(...(await deleteBatch(configuration, slice, call)));
  }

  return { requested: keys.length, failed };
}

/**
 * Spec 4.11: every object below the prefix, listed a page at a time and each page deleted
 * as it arrives, so the call holds one page of keys whatever the prefix holds.
 */
export async function deleteBelow(
  configuration: GcsConfiguration,
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
    carriesCursor: false,
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

/**
 * One batch of `DELETE` subrequests. The outer request's `Authorization` covers every
 * subrequest, so the body is built once and sent as it is on every attempt.
 */
async function deleteBatch(
  configuration: GcsConfiguration,
  keys: readonly string[],
  call: DeleteCall,
): Promise<readonly StorageError[]> {
  const boundary = batchBoundary();
  const response = await send(configuration, {
    method: "POST",
    operation: call.operation,
    path: batchPath(configuration),
    headers: [["content-type", batchContentType(boundary)]],
    body: batchBody(
      boundary,
      keys.map((key) => ({ method: "DELETE", path: objectPath(configuration, key), headers: [] })),
    ),
    signal: call.signal,
  });
  const answered: AnsweredRequest = {
    bucket: configuration.bucket,
    operation: call.operation,
    subject: "the deletion",
    response,
  };
  // The batch ran before an answer that breaks, so which keys it deleted is unknown; deleting
  // is idempotent, and the caller who repeats the call learns it.
  const reading = readBatchAnswer(
    response.headers.get("content-type"),
    await readAnswerText(answered),
    keys.length,
  );

  if ("unreadable" in reading) throw malformedAnswer(answered, reading.unreadable);

  if ("unanswered" in reading) {
    throw malformedAnswer(
      answered,
      `no answer for the key ${JSON.stringify(keys[reading.unanswered])}`,
    );
  }

  const failed: StorageError[] = [];

  for (const [index, key] of keys.entries()) {
    const failure = keyFailure(answered, key, reading.subresponses[index]!);

    if (failure !== undefined) failed.push(failure);
  }

  return failed;
}

/**
 * Spec 9.4: a subresponse `404 notFound` counts as deleted, and every other failed
 * subresponse is the key's entry, reported and not repeated (spec 9.5). A subresponse
 * carries no `x-guploader-uploadid`, so the entry takes the outer answer's (spec 9.8).
 */
function keyFailure(
  answered: AnsweredRequest,
  key: string,
  subresponse: BatchSubresponse,
): StorageError | undefined {
  const { status, headers } = subresponse;
  const succeeded = status >= 200 && status < 300;

  if (succeeded) return undefined;

  const body = readErrorBody(subresponse.body);
  const failure = providerError(
    answered.bucket,
    {
      operation: answered.operation,
      key,
      attempts: 1,
      requestId: answered.response.headers.get(requestIdHeader) ?? undefined,
    },
    {
      status,
      method: "DELETE",
      providerCode: body.providerCode,
      providerMessage: body.message,
      media: false,
      carriesCursor: false,
      sessionUri: false,
      underRefreshedToken: false,
      headers,
    },
  );

  if (failure.code !== "NotFound") return failure;

  // Spec 9.4: a batch answers a missing bucket with the same `404 notFound` as an absent
  // key, and only the message tells it apart, as the one `NotFound` that names no key.
  // It is the call's failure, not the key's.
  if (failure.key === undefined) throw failure;

  return undefined;
}

/**
 * The answer read in the `Content-ID` form GCS echoes and, where that form cannot read it,
 * in the one fake-gcs-server echoes, so the emulator of ADR 0034 runs `delete` on every
 * commit. No answer reads in both forms, and one that reads in neither is reported as the
 * GCS form reads it.
 */
function readBatchAnswer(
  contentType: string | null,
  body: string,
  subrequestCount: number,
): SubresponseReading {
  const reading = readSubresponses(contentType, body, subrequestCount, inResponseBrackets);

  if (!("unreadable" in reading)) return reading;

  const asSent = readSubresponses(contentType, body, subrequestCount, echoedAsSent);

  return "subresponses" in asSent ? asSent : reading;
}
