import type { DeleteReport, StorageError } from "@stowage/core";

import {
  type AnsweredRequest,
  answeredRequest,
  malformedAnswer,
  readAnswerText,
} from "./answer.ts";
import {
  batchBody,
  batchBoundary,
  batchContentType,
  readSubresponses,
  type Subresponse,
  subrequestsPerBatch,
} from "./batch.ts";
import type { AzureBlobConfiguration } from "./configuration.ts";
import type { AzureBlobCredentials } from "./credentials.ts";
import { keyRefusal } from "./key.ts";
import { maxPageSize, walkPages } from "./listing.ts";
import { providerError } from "./provider-code.ts";
import { authorizeHeaders, errorMessageOf, requestPath, send } from "./request.ts";
import { azureBlobError } from "./storage-error.ts";

const notFound = 404;

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

/**
 * Spec 4.11: every object below the prefix, listed a page at a time and each page deleted
 * as it arrives, so the call holds one page of keys whatever the prefix holds.
 */
export async function deleteBelow(
  configuration: AzureBlobConfiguration,
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
  const answered = answeredRequest(
    configuration.container,
    call.operation,
    "the deletion",
    response,
  );
  // The batch ran before an answer that breaks, so which keys it deleted is unknown; deleting
  // is idempotent, and the caller who repeats the call learns it.
  const subresponses = readSubresponses(
    response.headers.get("content-type"),
    await readAnswerText(answered, response),
  );

  if (subresponses === undefined) {
    throw malformedAnswer(answered, "an answer that is no batch of responses");
  }

  const expectedContentIds = new Set(keys.map((_, index) => String(index)));
  const byContentId = new Map<string, Subresponse>();

  for (const subresponse of subresponses) {
    const { contentId } = subresponse;

    if (!expectedContentIds.has(contentId)) {
      throw malformedAnswer(
        answered,
        `an answer for unexpected Content-ID ${JSON.stringify(contentId)}`,
      );
    }

    if (byContentId.has(contentId)) {
      throw malformedAnswer(answered, `two answers for Content-ID ${JSON.stringify(contentId)}`);
    }

    byContentId.set(contentId, subresponse);
  }

  for (const [index, key] of keys.entries()) {
    if (!byContentId.has(String(index))) {
      throw malformedAnswer(answered, `no answer for the key ${JSON.stringify(key)}`);
    }
  }

  const failed: StorageError[] = [];

  for (const [index, key] of keys.entries()) {
    const failure = keyFailure(answered, key, byContentId.get(String(index))!);

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
  answered: AnsweredRequest,
  key: string,
  subresponse: Subresponse,
): StorageError | undefined {
  const { status, headers } = subresponse;
  const succeeded = status >= 200 && status < 300;
  const alreadyAbsent = status === notFound && headers.get("x-ms-error-code") === "BlobNotFound";

  if (succeeded || alreadyAbsent) return undefined;

  return providerError(answered.container, {
    operation: answered.operation,
    method: "DELETE",
    key,
    status,
    headers,
    providerMessage: errorMessageOf(subresponse.body),
    attempts: 1,
    underRefreshedToken: false,
  });
}
