import {
  isStorageError,
  type ObjectStat,
  type SendParts,
  type StorageError,
  uploadStream,
  type XmlElement,
} from "@stowage/core";

import { type AnsweredRequest, readAnswerDocument, textOf } from "./answer-document.ts";
import type { HeaderField } from "./canonical.ts";
import type { S3Configuration } from "./configuration.ts";
import { describeWrite, unquotedEtag } from "./description.ts";
import { send } from "./request.ts";
import { s3Error } from "./storage-error.ts";
import type { UserMetadataHeaders } from "./user-metadata.ts";
import { escapeXml } from "./xml.ts";

/** What `put` writes, apart from the body. */
export interface ObjectWrite {
  readonly key: string;
  readonly contentType: string;
  readonly userMetadata: UserMetadataHeaders;
  readonly signal?: AbortSignal;
}

/** The object's own headers, which a multipart upload sends with the request that starts it. */
function objectHeaders(write: ObjectWrite): HeaderField[] {
  return [["content-type", write.contentType], ...write.userMetadata.headers];
}

/** Spec 7.6: bytes the adapter holds go as one `PUT`, which it never splits. */
export async function putObject(
  configuration: S3Configuration,
  write: ObjectWrite,
  bytes: Uint8Array<ArrayBuffer>,
): Promise<ObjectStat> {
  const response = await send(configuration, {
    method: "PUT",
    operation: "put",
    key: write.key,
    headers: objectHeaders(write),
    body: bytes,
    signal: write.signal,
  });

  await response.body?.cancel();

  return describeWrite(
    configuration.bucket,
    write.key,
    bytes.byteLength,
    write.contentType,
    write.userMetadata.held,
    response,
  );
}

/**
 * Spec 7.6: a stream is read into parts of `partSize`, and one that ends within the first
 * goes as the `PUT` held bytes get.
 */
export async function putStream(
  configuration: S3Configuration,
  write: ObjectWrite,
  stream: ReadableStream<Uint8Array>,
): Promise<ObjectStat> {
  return await uploadStream(
    stream,
    {
      partSize: configuration.partSize,
      concurrency: configuration.concurrency,
      maxParts,
      bucket: configuration.bucket,
      provider: "s3",
      key: write.key,
      signal: write.signal,
    },
    {
      whole: async (bytes) => await putObject(configuration, write, bytes),
      multipart: async (sendParts) => await multipartUpload(configuration, write, sendParts),
    },
  );
}

interface UploadedPart {
  readonly number: number;
  readonly etag: string;
}

const s3Namespace = "http://s3.amazonaws.com/doc/2006-03-01/";

/** The provider's limit on both sides, which ADR 0016 leaves no option to lift. */
const maxParts = 10_000;

/**
 * Spec 7.6: a multipart upload aborts itself once it failed, after the parts in flight
 * and the source stream were canceled.
 */
async function multipartUpload(
  configuration: S3Configuration,
  write: ObjectWrite,
  sendParts: SendParts,
): Promise<ObjectStat> {
  const uploadId = await createUpload(configuration, write);
  let sent: { readonly results: readonly UploadedPart[]; readonly size: number };

  try {
    sent = await sendParts(async (index, bytes, signal) => {
      const number = index + 1;
      const etag = await uploadPart(configuration, { ...write, signal }, uploadId, number, bytes);

      return { number, etag };
    });
  } catch (failure) {
    await abortUpload(configuration, write, uploadId);

    throw failure;
  }

  return await completeUpload(configuration, write, uploadId, sent.results, sent.size);
}

async function createUpload(configuration: S3Configuration, write: ObjectWrite): Promise<string> {
  const response = await send(configuration, {
    method: "POST",
    operation: "put",
    key: write.key,
    query: [["uploads", ""]],
    headers: objectHeaders(write),
    signal: write.signal,
  });
  const subject = "the start of the upload";
  const document = await readAnswerDocument(
    answeredRequest(configuration, write, subject),
    response,
    "InitiateMultipartUploadResult",
  );
  const uploadId = textOf(document, "UploadId");

  if (uploadId === undefined || uploadId === "") {
    throw incompleteAnswer(configuration, write, response, subject, "no upload id");
  }

  return uploadId;
}

async function uploadPart(
  configuration: S3Configuration,
  write: ObjectWrite,
  uploadId: string,
  number: number,
  bytes: Uint8Array<ArrayBuffer>,
): Promise<string> {
  const response = await send(configuration, {
    method: "PUT",
    operation: "put",
    key: write.key,
    query: [
      ["partNumber", String(number)],
      ["uploadId", uploadId],
    ],
    body: bytes,
    signal: write.signal,
  });

  await response.body?.cancel();

  const etag = response.headers.get("etag");

  if (etag === null || etag === "") {
    throw incompleteAnswer(configuration, write, response, `part ${number}`, "no entity tag");
  }

  return etag;
}

async function completeUpload(
  configuration: S3Configuration,
  write: ObjectWrite,
  uploadId: string,
  uploaded: readonly UploadedPart[],
  size: number,
): Promise<ObjectStat> {
  let response: Response;
  let document: XmlElement;

  try {
    response = await send(configuration, {
      method: "POST",
      operation: "put",
      key: write.key,
      query: [["uploadId", uploadId]],
      headers: [["content-type", "application/xml"]],
      body: utf8.encode(completeDocument(uploaded)),
      signal: write.signal,
      repeatWithoutResponse: false,
    });
    document = await readAnswerDocument(
      answeredRequest(configuration, write, "the completion of the upload"),
      response,
      "CompleteMultipartUploadResult",
    );
  } catch (failure) {
    if (!mayHaveCommitted(failure, write.signal)) await abortUpload(configuration, write, uploadId);

    throw failure;
  }

  const etag = textOf(document, "ETag");

  return describeWrite(
    configuration.bucket,
    write.key,
    size,
    write.contentType,
    write.userMetadata.held,
    response,
    etag === undefined ? undefined : unquotedEtag(etag),
  );
}

/**
 * Spec 7.7 leaves a completion that received no response unaborted, because an abort
 * could meet a commit still on its way. The same holds for a `200` that broke before its
 * body said how the commit went, since S3 sends that status before it has decided, and
 * for the caller's abort while the completion was out: the request may have arrived.
 * Only the provider's answer that it did not commit is aborted.
 */
function mayHaveCommitted(failure: unknown, signal: AbortSignal | undefined): boolean {
  if (signal?.aborted) return true;

  return isStorageError(failure) && failure.code === "NetworkError";
}

/**
 * Spec 7.6: sent without a signal, because the caller's may be the one that just fired,
 * and never reported, because the failure that led here is what the caller is owed. What
 * a failed abort leaves behind is removed by the lifecycle rule of spec 7.2.
 */
async function abortUpload(
  configuration: S3Configuration,
  write: ObjectWrite,
  uploadId: string,
): Promise<void> {
  try {
    const response = await send(configuration, {
      method: "DELETE",
      operation: "put",
      key: write.key,
      query: [["uploadId", uploadId]],
    });

    await response.body?.cancel();
  } catch {}
}

const utf8 = new TextEncoder();

function completeDocument(uploaded: readonly UploadedPart[]): string {
  const parts = uploaded
    .map(
      ({ number, etag }) =>
        `<Part><PartNumber>${number}</PartNumber><ETag>${escapeXml(etag)}</ETag></Part>`,
    )
    .join("");

  return `<?xml version="1.0" encoding="UTF-8"?><CompleteMultipartUpload xmlns="${s3Namespace}">${parts}</CompleteMultipartUpload>`;
}

function answeredRequest(
  configuration: S3Configuration,
  write: ObjectWrite,
  subject: string,
): AnsweredRequest {
  return { bucket: configuration.bucket, operation: "put", key: write.key, subject };
}

// An answer that leaves out what the next request of the upload needs cannot be carried
// on, and spec 4.10 names it a `ProviderError` rather than a value invented for it.
function incompleteAnswer(
  configuration: S3Configuration,
  write: ObjectWrite,
  response: Response,
  subject: string,
  missing: string,
): StorageError {
  return s3Error(configuration.bucket, {
    code: "ProviderError",
    message: `The provider answered ${subject} with ${missing}`,
    operation: "put",
    key: write.key,
    attempts: 1,
    status: response.status,
    requestId: response.headers.get("x-amz-request-id") ?? undefined,
  });
}
