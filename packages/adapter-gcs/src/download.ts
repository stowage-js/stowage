import { type ByteRange, rangeHeader, type StoredObject } from "@stowage/core";

import type { GcsConfiguration } from "./configuration.ts";
import { type DescribedObject, readDescription } from "./description.ts";
import { answeredRangeRefusal, isUnsatisfiedRange, reportedDownloadFailure } from "./range.ts";
import { objectPath, pinnedTo, send } from "./request.ts";
import { isMissingObject } from "./storage-error.ts";
import { createStoredObject } from "./stored-object.ts";

/** The header GCS names the generation of a media download's body in. */
const generationHeader = "x-goog-generation";

/** A body and the description of the generation it carries. */
interface Download {
  readonly described: DescribedObject;
  readonly response: Response;
}

/**
 * Spec 9.4: the resource request and the media download side by side, since the media
 * download carries no user metadata, and at most two pinned requests after them where a
 * writer replaced the object in between, so that `stat` describes the bytes the body carries.
 */
export async function getObject(
  configuration: GcsConfiguration,
  key: string,
  range: ByteRange | undefined,
  signal: AbortSignal | undefined,
): Promise<StoredObject> {
  const download = await ofOneGeneration(
    configuration,
    key,
    range,
    signal,
    await sideBySide(configuration, key, range, signal),
  );
  const refusal = answeredRangeRefusal(
    configuration.bucket,
    key,
    range,
    download.described,
    download.response,
  );

  if (refusal !== undefined) {
    await cancelBody(download.response);

    throw refusal;
  }

  return createStoredObject(configuration.bucket, download.described.stat, download.response);
}

/**
 * Where the resource request fails its failure is reported, and a failure of the download
 * only where the resource succeeded; either failure aborts the other request (spec 9.8),
 * except a `416` refusing the range, whose report names the size the resource answers with.
 */
async function sideBySide(
  configuration: GcsConfiguration,
  key: string,
  range: ByteRange | undefined,
  callerSignal: AbortSignal | undefined,
): Promise<Download> {
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
    readDescription(configuration, key, "get", { signal }).catch(abortOther),
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

  if (download.status === "rejected") {
    throw reportedDownloadFailure(
      configuration.bucket,
      key,
      range,
      described.value,
      download.reason,
    );
  }

  return { described: described.value, response: download.value };
}

/**
 * ADR 0040: where the two name different generations, the resource of the body's generation
 * is read first, and the body is kept. Where that generation is gone, the first resource's
 * is downloaded instead. Which one is newer is not asked: GCS promises generations unique,
 * not increasing, and which request reached it first is the network's to decide.
 */
async function ofOneGeneration(
  configuration: GcsConfiguration,
  key: string,
  range: ByteRange | undefined,
  signal: AbortSignal | undefined,
  first: Download,
): Promise<Download> {
  const bodyGeneration = first.response.headers.get(generationHeader);
  const { generation } = first.described;

  if (bodyGeneration === null || generation === undefined || bodyGeneration === generation) {
    return first;
  }

  const described = await readDescription(configuration, key, "get", {
    signal,
    generation: bodyGeneration,
  }).catch(async (failure: unknown) => {
    if (isMissingObject(failure)) return undefined;

    await cancelBody(first.response);

    throw failure;
  });

  if (described !== undefined) return { described, response: first.response };

  await cancelBody(first.response);

  // Spec 9.8: a `404` here is `NotFound` naming the key, although the key may by now hold
  // a newer object, which `get` called again reads.
  const response = await sendDownload(configuration, key, range, signal, generation).catch(
    (failure: unknown) => {
      throw reportedDownloadFailure(configuration.bucket, key, range, first.described, failure);
    },
  );

  return { described: first.described, response };
}

async function sendDownload(
  configuration: GcsConfiguration,
  key: string,
  range: ByteRange | undefined,
  signal: AbortSignal | undefined,
  generation?: string,
): Promise<Response> {
  return await send(configuration, {
    method: "GET",
    operation: "get",
    key,
    path: objectPath(configuration, key),
    query: [["alt", "media"], ...pinnedTo(generation)],
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
