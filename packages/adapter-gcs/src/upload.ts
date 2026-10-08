import {
  type ContentHeaders,
  isStorageError,
  type ObjectStat,
  type SendParts,
  uploadStream,
} from "@stowage/core";

import type { GcsConfiguration } from "./configuration.ts";
import { describeResource, readResource } from "./description.ts";
import { send, uploadPath } from "./request.ts";
import { startSession } from "./session.ts";

export interface ObjectWrite {
  readonly key: string;
  readonly contentType: string;
  readonly contentHeaders: ContentHeaders;
  readonly userMetadata: Readonly<Record<string, string>>;
  readonly signal?: AbortSignal;
}

const utf8 = new TextEncoder();

/**
 * Spec 9.6: held bytes go as one `uploadType=multipart` request, whose first part is the
 * object's resource and whose second is the bytes. `put` resolves with the object the
 * answer describes, so no `stat` follows.
 */
export async function putBytes(
  configuration: GcsConfiguration,
  write: ObjectWrite,
  bytes: Uint8Array<ArrayBuffer>,
): Promise<ObjectStat> {
  const boundary = `stowage-${crypto.randomUUID()}`;
  const response = await send(configuration, {
    method: "POST",
    operation: "put",
    key: write.key,
    path: uploadPath(configuration),
    query: [["uploadType", "multipart"]],
    headers: [["content-type", `multipart/related; boundary=${boundary}`]],
    body: multipartBody(boundary, write, bytes),
    signal: write.signal,
  });
  const resource = await readResource(configuration.bucket, write.key, "put", response);

  return describeResource(configuration.bucket, write.key, "put", response, resource);
}

/**
 * Spec 9.6: a stream is read into parts of `partSize`, and one that ends within the first
 * goes as the request held bytes get. A longer one goes as one resumable session, which
 * takes one chunk at a time and has no limit on its parts (ADR 0036).
 */
export async function putStream(
  configuration: GcsConfiguration,
  write: ObjectWrite,
  stream: ReadableStream<Uint8Array>,
): Promise<ObjectStat> {
  return await uploadStream(
    stream,
    {
      partSize: configuration.partSize,
      concurrency: 1,
      maxParts: Infinity,
      bucket: configuration.bucket,
      provider: "gcs",
      key: write.key,
      signal: write.signal,
    },
    {
      whole: async (bytes) => await putBytes(configuration, write, bytes),
      multipart: async (sendParts) => await resumableUpload(configuration, write, sendParts),
    },
  );
}

/**
 * Part `i` goes at offset `i × partSize`. A part shorter than `partSize` is the last one and
 * commits; where the last part was full, an empty chunk naming the total commits after it,
 * since the core reads the next part only once this one settled (ADR 0036).
 *
 * A failed or aborted upload cancels its session. Where the commit went unanswered, the
 * cancel's answer says whether the session committed after all, and a committed session's
 * object is what `put` resolves with (spec 9.6).
 */
async function resumableUpload(
  configuration: GcsConfiguration,
  write: ObjectWrite,
  sendParts: SendParts,
): Promise<ObjectStat> {
  const session = await startSession(configuration, {
    key: write.key,
    resource: objectResource(write),
    signal: write.signal,
  });
  const { partSize } = configuration;
  let committing = false;

  try {
    const sent = await sendParts(async (index, bytes, signal) => {
      const offset = index * partSize;

      if (bytes.byteLength === partSize) {
        await session.send({ offset, bytes }, signal);

        return undefined;
      }

      committing = true;

      return await session.commit({ offset, bytes, total: offset + bytes.byteLength }, signal);
    });
    const committed = sent.results.at(-1);

    if (committed !== undefined) return committed;

    committing = true;

    return await session.commit(
      { offset: sent.size, bytes: new Uint8Array(0), total: sent.size },
      write.signal,
    );
  } catch (failure) {
    const object = await session.cancel(committing && isUnanswered(failure, write.signal));

    if (object !== undefined) return object;

    throw failure;
  }
}

/**
 * Spec 9.6 settles a commit by the cancel only where no answer said how it went. An answered
 * failure is reported as it stands, and the caller's abort rejects with `AbortError` even
 * where the commit arrived.
 */
function isUnanswered(failure: unknown, signal: AbortSignal | undefined): boolean {
  if (signal?.aborted === true) return false;

  return isStorageError(failure) && failure.code === "NetworkError";
}

/**
 * The object's resource as the JSON API takes it: name, content type, content headers and
 * user metadata.
 */
function objectResource(write: ObjectWrite): string {
  return JSON.stringify({
    name: write.key,
    contentType: write.contentType,
    ...write.contentHeaders,
    ...(Object.keys(write.userMetadata).length === 0 ? {} : { metadata: write.userMetadata }),
  });
}

/**
 * The `multipart/related` body of RFC 2387. The boundary is random per request: a body
 * that held it would end its part early, and 122 random bits make that no concern.
 */
function multipartBody(
  boundary: string,
  write: ObjectWrite,
  bytes: Uint8Array<ArrayBuffer>,
): Uint8Array<ArrayBuffer> {
  const resource = objectResource(write);
  const head = utf8.encode(
    [
      `--${boundary}`,
      "Content-Type: application/json; charset=UTF-8",
      "",
      resource,
      `--${boundary}`,
      `Content-Type: ${write.contentType}`,
      "",
      "",
    ].join("\r\n"),
  );
  const tail = utf8.encode(`\r\n--${boundary}--\r\n`);
  const body = new Uint8Array(head.byteLength + bytes.byteLength + tail.byteLength);

  body.set(head, 0);
  body.set(bytes, head.byteLength);
  body.set(tail, head.byteLength + bytes.byteLength);

  return body;
}
