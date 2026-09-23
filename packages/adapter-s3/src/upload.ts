import { isStorageError, type ObjectStat, type StorageError } from "@stowage/core";

import { type AnsweredRequest, readAnswerDocument, textOf } from "./answer-document.ts";
import type { S3Configuration } from "./configuration.ts";
import { describeWrite, unquotedEtag } from "./description.ts";
import { type Part, PartReader } from "./part-reader.ts";
import { send } from "./request.ts";
import { s3Error } from "./storage-error.ts";
import type { UserMetadataHeaders } from "./user-metadata.ts";
import { escapeXml, type XmlElement } from "./xml.ts";

/** What `put` writes, apart from the body. */
export interface ObjectWrite {
  readonly key: string;
  readonly contentType: string;
  readonly userMetadata: UserMetadataHeaders;
  readonly signal?: AbortSignal;
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
    headers: [["content-type", write.contentType], ...write.userMetadata.headers],
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
export async function uploadStream(
  configuration: S3Configuration,
  write: ObjectWrite,
  stream: ReadableStream<Uint8Array>,
): Promise<ObjectStat> {
  const parts = new PartReader(stream, configuration.partSize, write.signal);

  try {
    const first = await parts.next();

    if (first.last) return await putObject(configuration, write, first.bytes);

    return await multipartUpload(configuration, write, parts, first);
  } catch (failure) {
    await parts.cancel(failure);

    throw failure;
  } finally {
    parts.release();
  }
}

interface UploadedPart {
  readonly number: number;
  readonly etag: string;
}

const s3Namespace = "http://s3.amazonaws.com/doc/2006-03-01/";

/** The provider's limit on both sides, which ADR 0016 leaves no option to lift. */
const maxParts = 10_000;

interface SentParts {
  /** In part-number order, which is how `CompleteMultipartUpload` lists them. */
  readonly uploaded: readonly UploadedPart[];
  readonly size: number;
}

/**
 * Spec 7.6: a multipart upload aborts itself once it failed, after the parts in flight
 * and the source stream were canceled.
 */
async function multipartUpload(
  configuration: S3Configuration,
  write: ObjectWrite,
  parts: PartReader,
  first: Part,
): Promise<ObjectStat> {
  const uploadId = await createUpload(configuration, write);
  let sent: SentParts;

  try {
    sent = await sendParts(configuration, write, uploadId, parts, first);
  } catch (failure) {
    await parts.cancel(failure);
    await abortUpload(configuration, write, uploadId);

    throw failure;
  }

  return await completeUpload(configuration, write, uploadId, sent);
}

/**
 * Spec 7.6: `concurrency` parts in flight, and the next part read only once one of them
 * settled, so the part buffers never outnumber the parts in flight. The first failure
 * stops the parts still in flight, and is what the upload rejects with once they settled.
 */
async function sendParts(
  configuration: S3Configuration,
  write: ObjectWrite,
  uploadId: string,
  parts: PartReader,
  first: Part,
): Promise<SentParts> {
  const stop = new AbortController();
  const partWrite: ObjectWrite = {
    ...write,
    signal: write.signal === undefined ? stop.signal : AbortSignal.any([write.signal, stop.signal]),
  };
  const inFlight = new Set<Promise<void>>();
  const uploaded: UploadedPart[] = [];
  let failure: { readonly reason: unknown } | undefined;
  let size = 0;

  const fail = (reason: unknown): void => {
    failure ??= { reason };
    stop.abort();
  };
  const sendPart = async (number: number, part: Part): Promise<void> => {
    try {
      const etag = await uploadPart(configuration, partWrite, uploadId, number, part);

      uploaded.push({ number, etag });
    } catch (reason) {
      fail(reason);
    }
  };

  try {
    for (let number = 1, part = first; ; number += 1) {
      if (number === maxParts && !part.last) throw tooManyParts(configuration, write);

      const sending = sendPart(number, part);

      inFlight.add(sending);
      void sending.finally(() => inFlight.delete(sending));
      size += part.bytes.byteLength;

      if (part.last) break;

      // oxlint-disable-next-line no-await-in-loop -- a free slot is what lets the next part go
      while (inFlight.size >= configuration.concurrency) await Promise.race(inFlight);

      if (failure !== undefined) break;

      // oxlint-disable-next-line no-await-in-loop -- the next part is read into the free slot
      part = await parts.next();
    }
  } catch (reason) {
    fail(reason);
  }

  await Promise.all(inFlight);

  if (failure !== undefined) throw failure.reason;

  return { uploaded: uploaded.toSorted((one, other) => one.number - other.number), size };
}

async function createUpload(configuration: S3Configuration, write: ObjectWrite): Promise<string> {
  const response = await send(configuration, {
    method: "POST",
    operation: "put",
    key: write.key,
    query: [["uploads", ""]],
    headers: [["content-type", write.contentType], ...write.userMetadata.headers],
    signal: write.signal,
  });
  const answered = answeredRequest(configuration, write, "the start of the upload");
  const document = await readAnswerDocument(answered, response, "InitiateMultipartUploadResult");
  const uploadId = textOf(document, "UploadId");

  if (uploadId === undefined || uploadId === "") {
    throw incompleteAnswer(
      configuration,
      write,
      response,
      "the start of the upload",
      "no upload id",
    );
  }

  return uploadId;
}

async function uploadPart(
  configuration: S3Configuration,
  write: ObjectWrite,
  uploadId: string,
  number: number,
  part: Part,
): Promise<string> {
  const response = await send(configuration, {
    method: "PUT",
    operation: "put",
    key: write.key,
    query: [
      ["partNumber", String(number)],
      ["uploadId", uploadId],
    ],
    body: part.bytes,
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
  { uploaded, size }: SentParts,
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
    if (!mayHaveCommitted(failure)) await abortUpload(configuration, write, uploadId);

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
 * Spec 7.7: a completion that received no response may have committed, and one whose
 * `200` broke before its body said which is as undecided. Neither is aborted, because an
 * abort could meet a commit still on its way.
 */
function mayHaveCommitted(failure: unknown): boolean {
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

/**
 * Spec 7.6: known once the last part the provider takes is full and the stream goes on.
 * ADR 0016 fixes the part size before the first part, so the way past it is a larger one.
 */
function tooManyParts(configuration: S3Configuration, write: ObjectWrite): StorageError {
  return s3Error(configuration.bucket, {
    code: "InvalidRequest",
    message: `The stream needs more than ${maxParts} parts of the configured \`partSize\` of ${configuration.partSize} bytes; a larger \`multipart.partSize\` carries it`,
    operation: "put",
    key: write.key,
    attempts: 0,
  });
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
