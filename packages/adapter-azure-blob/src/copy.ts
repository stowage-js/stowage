import { isStorageError, type ObjectStat, type StorageError } from "@stowage/core";

import type { AzureBlobConfiguration } from "./configuration.ts";
import type { AzureBlobCredentials } from "./credentials.ts";
import { readContentHeaders, sentContentHeaders } from "./content-headers.ts";
import { describeResponse } from "./description.ts";
import { blobUrl, send } from "./request.ts";
import { sasWindow, signServiceSas } from "./sas.ts";
import type { HeaderField } from "./sign.ts";
import { asRetryable } from "./storage-error.ts";

const minute = 60 * 1000;
const preconditionFailed = 412;

/** ADR 0025: long enough for the service to read the largest source one copy takes. */
const sourceSasLifetime = 60 * minute;

/**
 * ADR 0013 bounds the repeats of one request to three attempts, and the copy of a source that
 * keeps being replaced takes no more.
 */
const copyAttempts = 3;

/**
 * Spec 8.7: a `HEAD` of the source, then one `Put Blob From URL` pinned to the entity tag the
 * `HEAD` read, which is synchronous and leaves the destination as it was where it fails. It
 * names no user metadata, so the service copies the source's; its answer names neither the
 * size nor the user metadata of what it wrote, so a `HEAD` of the destination describes it.
 */
export async function copyBlob(
  configuration: AzureBlobConfiguration,
  from: string,
  to: string,
  operation: string,
  signal: AbortSignal | undefined,
): Promise<ObjectStat> {
  signal?.throwIfAborted();

  for (let attempt = 1; ; attempt += 1) {
    try {
      // oxlint-disable-next-line no-await-in-loop -- a repeat reads the source the last one missed
      await copyPinned(configuration, from, to, operation, signal);

      break;
    } catch (failure) {
      if (!isReplacedSource(failure)) throw failure;

      // ADR 0068: a later copy may meet a source that stays put between its two requests.
      if (attempt === copyAttempts) throw asRetryable(failure, configuration.container);
    }
  }

  const described = await send(configuration, { method: "HEAD", operation, key: to, signal });

  return describeResponse(configuration.container, to, operation, described);
}

/** ADR 0068: the properties the copy restates and the pin both come from one `HEAD`. */
async function copyPinned(
  configuration: AzureBlobConfiguration,
  from: string,
  to: string,
  operation: string,
  signal: AbortSignal | undefined,
): Promise<void> {
  const source = await send(configuration, { method: "HEAD", operation, key: from, signal });
  const pin = source.headers.get("etag") ?? "";

  await source.body?.cancel();

  const response = await send(configuration, {
    method: "PUT",
    operation,
    key: to,
    copySource: from,
    headers: async (credentials) => [
      ["x-ms-blob-type", "BlockBlob"],
      ["x-ms-source-if-match", pin],
      ...restatedProperties(source.headers),
      ...(await sourceAuthorization(configuration, from, credentials)),
    ],
    // Azure requires `Content-Length: 0`, which `fetch` sends for an empty body alone.
    body: new Uint8Array(0),
    signal,
  });

  await response.body?.cancel();
}

/**
 * ADR 0068: a source replaced between the `HEAD` and the copy fails the pin, which the
 * service answers as a failure on the source with the status of the failed condition.
 */
function isReplacedSource(failure: unknown): failure is StorageError {
  return (
    isStorageError(failure) &&
    failure.providerCode === "CannotVerifyCopySource" &&
    failure.status === preconditionFailed
  );
}

/**
 * ADR 0068: the service rewrites each of these it copies on its own into a canonical form
 * its documentation does not describe, and stores one restated on the copy as sent. All five
 * the source holds are restated, so that no rewrite the service may add later reaches them.
 */
function restatedProperties(source: Headers): HeaderField[] {
  const contentType = source.get("content-type");
  const contentEncoding = source.get("content-encoding");

  return [
    ...(contentType === null ? [] : [["x-ms-blob-content-type", contentType] as const]),
    ...(contentEncoding === null || contentEncoding === ""
      ? []
      : [["x-ms-blob-content-encoding", contentEncoding] as const]),
    ...sentContentHeaders(readContentHeaders(source)),
  ];
}

/**
 * ADR 0025: a request signed with Shared Key does not authorize its source, even within
 * one account. Under an account key the source URL carries a service SAS signed with the
 * key this attempt resolved; under an access token the source is authorized by the same
 * token as the request, so the repeat of spec 8.3 renews both.
 */
async function sourceAuthorization(
  configuration: AzureBlobConfiguration,
  from: string,
  credentials: AzureBlobCredentials,
): Promise<readonly HeaderField[]> {
  if ("accessToken" in credentials) {
    return [
      ["x-ms-copy-source", blobUrl(configuration, from, [])],
      ["x-ms-copy-source-authorization", `Bearer ${credentials.accessToken}`],
    ];
  }

  const sas = await signServiceSas(
    configuration,
    { key: from, permissions: "r", ...sasWindow(sourceSasLifetime) },
    credentials.accountKey,
  );

  return [["x-ms-copy-source", blobUrl(configuration, from, sas.query)]];
}
