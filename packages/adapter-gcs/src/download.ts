import { type ByteRange, rangeHeader, type StoredObject } from "@stowage/core";

import type { GcsConfiguration } from "./configuration.ts";
import { readDescription } from "./description.ts";
import {
  isUnsatisfiedRange,
  partialContent,
  reportedDownloadFailure,
  wholeAnswerFailure,
} from "./range.ts";
import { objectPath, send } from "./request.ts";
import { createStoredObject } from "./stored-object.ts";

/**
 * Spec 9.4: the resource request and the media download side by side, since the media
 * download carries no user metadata. Where the resource request fails its failure is
 * reported, and a failure of the download only where the resource succeeded; either
 * failure aborts the other request (spec 9.8), except a `416` refusing the range, whose
 * report names the size the resource answers with.
 */
export async function getObject(
  configuration: GcsConfiguration,
  key: string,
  range: ByteRange | undefined,
  callerSignal: AbortSignal | undefined,
): Promise<StoredObject> {
  const abortPair = new AbortController();
  const signal =
    callerSignal === undefined
      ? abortPair.signal
      : AbortSignal.any([callerSignal, abortPair.signal]);
  const abortOther = (failure: unknown): never => {
    abortPair.abort();

    throw failure;
  };
  const [described, download] = await Promise.allSettled([
    readDescription(configuration, key, "get", signal).catch(abortOther),
    sendDownload(configuration, key, range, signal).catch((failure: unknown) => {
      if (isUnsatisfiedRange(range, failure)) throw failure;

      return abortOther(failure);
    }),
  ]);

  if (described.status === "rejected") {
    if (download.status === "fulfilled") await cancelBody(download.value);

    // The resource request was aborted because the download failed first, and not by
    // the caller, so the download's failure is the one to report.
    if (download.status === "rejected" && isAbortNotFromCaller(described.reason, callerSignal)) {
      throw download.reason;
    }

    throw described.reason;
  }

  const stat = described.value;

  if (download.status === "rejected") {
    throw reportedDownloadFailure(configuration.bucket, key, range, stat.size, download.reason);
  }

  const response = download.value;
  const refusal =
    range === undefined || response.status === partialContent
      ? undefined
      : wholeAnswerFailure(configuration.bucket, key, range, stat.size, response);

  if (refusal !== undefined) {
    await cancelBody(response);

    throw refusal;
  }

  return createStoredObject(configuration.bucket, stat, response);
}

async function sendDownload(
  configuration: GcsConfiguration,
  key: string,
  range: ByteRange | undefined,
  signal: AbortSignal,
): Promise<Response> {
  return await send(configuration, {
    method: "GET",
    operation: "get",
    key,
    path: objectPath(configuration, key),
    query: [["alt", "media"]],
    headers: range === undefined ? [] : [["range", rangeHeader(range)]],
    media: true,
    signal,
  });
}

async function cancelBody(response: Response): Promise<void> {
  await response.body?.cancel().catch(() => {});
}

function isAbortNotFromCaller(failure: unknown, callerSignal: AbortSignal | undefined): boolean {
  return (
    failure instanceof Error && failure.name === "AbortError" && callerSignal?.aborted !== true
  );
}
