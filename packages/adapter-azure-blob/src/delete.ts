import { type DeleteReport, isTransientStatus, type StorageError } from "@stowage/core";

import {
  batchBody,
  batchBoundary,
  batchContentType,
  readBatchAnswer,
  type Subresponse,
  subrequestsPerBatch,
} from "./batch.ts";
import type { AzureBlobConfiguration } from "./configuration.ts";
import type { AzureBlobCredentials } from "./credentials.ts";
import { keyRefusal } from "./key.ts";
import { readProviderFailure } from "./provider-code.ts";
import { authorizeHeaders, errorMessageOf, requestPath, send } from "./request.ts";
import { azureBlobError } from "./storage-error.ts";

const notFound = 404;

interface DeleteCall {
  readonly operation: string;
  readonly signal?: AbortSignal;
}

/** What the provider answered a batch with, as much of it as a failure told against it reads. */
interface BatchAnswer {
  readonly status: number;
  readonly requestId?: string;
}

/**
 * Spec 4.7: every key is reported, the invalid ones as `InvalidKey` without being sent,
 * and a failure of a batch as a whole rejects the call instead of filling the report.
 */
export async function deleteKeys(
  configuration: AzureBlobConfiguration,
  keys: readonly string[],
  call: DeleteCall,
): Promise<DeleteReport> {
  const failed: StorageError[] = [];
  const sendable: string[] = [];

  for (const key of keys) {
    const refusal = refusalOf(configuration.container, key, call.operation);

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

function refusalOf(container: string, key: string, operation: string): StorageError | undefined {
  const invalid = keyRefusal(container, key, "addressable", operation);

  if (invalid !== undefined) return invalid;

  // A lone surrogate has no UTF-8 form to percent-encode into the path of its subrequest.
  if (key.isWellFormed()) return undefined;

  return azureBlobError(container, {
    code: "InvalidKey",
    message: `The key ${JSON.stringify(key)} holds a lone surrogate, which has no UTF-8 form`,
    operation,
    key,
    attempts: 0,
  });
}

/**
 * One Blob Batch of `Delete Blob` subrequests. Azure authorizes each subrequest on its own,
 * so the body is built for every attempt under the credential that attempt resolved.
 */
async function deleteBatch(
  configuration: AzureBlobConfiguration,
  keys: readonly string[],
  call: DeleteCall,
): Promise<readonly StorageError[]> {
  call.signal?.throwIfAborted();

  const boundary = batchBoundary();
  const paths = keys.map((key) => requestPath(configuration, key));
  const response = await send(configuration, {
    method: "POST",
    operation: call.operation,
    query: [
      ["restype", "container"],
      ["comp", "batch"],
    ],
    headers: [["content-type", batchContentType(boundary)]],
    body: async (credentials) =>
      batchBody(boundary, await deleteSubrequests(configuration, paths, credentials)),
    signal: call.signal,
  });
  const answer: BatchAnswer = {
    status: response.status,
    requestId: response.headers.get("x-ms-request-id") ?? undefined,
  };
  const subresponses = readBatchAnswer(
    response.headers.get("content-type"),
    await readBody(configuration, call, answer, response),
  );

  if (subresponses === undefined) {
    throw unreadable(configuration, call, answer, "an answer that is no batch of responses");
  }

  const byContentId = new Map(
    subresponses.map((subresponse) => [subresponse.contentId, subresponse]),
  );
  const failed: StorageError[] = [];

  for (const [index, key] of keys.entries()) {
    const subresponse = byContentId.get(String(index));

    if (subresponse === undefined) {
      throw unreadable(configuration, call, answer, `no answer for the key ${JSON.stringify(key)}`);
    }

    const failure = keyFailure(configuration, call, key, subresponse);

    if (failure !== undefined) failed.push(failure);
  }

  return failed;
}

async function deleteSubrequests(
  configuration: AzureBlobConfiguration,
  paths: readonly string[],
  credentials: AzureBlobCredentials,
) {
  const date = new Date().toUTCString();

  return await Promise.all(
    paths.map(async (path) => ({
      method: "DELETE",
      path,
      // The batch names the version once, on the request that carries it.
      headers: await authorizeHeaders(
        configuration,
        { method: "DELETE", path, query: [], headers: [["x-ms-date", date]], contentLength: 0 },
        credentials,
      ),
    })),
  );
}

/**
 * Spec 8.4: a key already absent counts as deleted, and every other failed subrequest is
 * the key's entry, reported and not repeated (spec 8.5).
 */
function keyFailure(
  configuration: AzureBlobConfiguration,
  call: DeleteCall,
  key: string,
  subresponse: Subresponse,
): StorageError | undefined {
  const { status, headers } = subresponse;
  const providerCode = headers.get("x-ms-error-code") ?? undefined;

  const succeeded = status >= 200 && status < 300;

  if (succeeded || (status === notFound && providerCode === "BlobNotFound")) return undefined;

  const failure = readProviderFailure({
    status,
    method: "DELETE",
    key,
    providerCode,
    providerMessage: errorMessageOf(subresponse.body),
    underRefreshedToken: false,
  });

  return azureBlobError(configuration.container, {
    code: failure.code,
    message: failure.message,
    operation: call.operation,
    key,
    attempts: 1,
    status,
    providerCode,
    requestId: headers.get("x-ms-request-id") ?? undefined,
    retryable: isTransientStatus(status),
  });
}

/**
 * The batch ran before its answer broke, so which keys it deleted is unknown; deleting is
 * idempotent, and the caller who repeats the call learns it.
 */
async function readBody(
  configuration: AzureBlobConfiguration,
  call: DeleteCall,
  answer: BatchAnswer,
  response: Response,
): Promise<string> {
  try {
    return await response.text();
  } catch (failure) {
    // Spec 4.10: the caller's abort travels on as the runtime's `AbortError`.
    if (failure instanceof Error && failure.name === "AbortError") throw failure;

    throw azureBlobError(configuration.container, {
      code: "NetworkError",
      message: `The answer to the deletion broke while it was read: ${String(failure)}`,
      operation: call.operation,
      attempts: 1,
      status: answer.status,
      requestId: answer.requestId,
      retryable: true,
      cause: failure,
    });
  }
}

function unreadable(
  configuration: AzureBlobConfiguration,
  call: DeleteCall,
  answer: BatchAnswer,
  what: string,
): StorageError {
  return azureBlobError(configuration.container, {
    code: "ProviderError",
    message: `The provider answered the deletion with ${what}`,
    operation: call.operation,
    attempts: 1,
    status: answer.status,
    requestId: answer.requestId,
  });
}
