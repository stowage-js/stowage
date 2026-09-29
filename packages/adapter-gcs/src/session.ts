import { isStorageError, type ObjectStat, type StorageError, withRetry } from "@stowage/core";

import { type AnsweredRequest, malformedAnswer } from "./answer.ts";
import type { GcsConfiguration } from "./configuration.ts";
import { describeResource, readResource } from "./description.ts";
import { resumeIncomplete, send, sendToSession, uploadPath } from "./request.ts";
import { gcsError, withoutSecrets } from "./storage-error.ts";

/** What a session is started for: the object's resource, as the start's body carries it. */
export interface SessionStart {
  readonly key: string;
  readonly resource: string;
  readonly signal?: AbortSignal;
}

/** Bytes at their offset in the object, the total named where they commit the session. */
export interface Chunk {
  readonly offset: number;
  readonly bytes: Uint8Array<ArrayBuffer>;
  readonly total?: number;
}

/** Spec 9.6: every attempt of the cancel, its backoff and reading its answer, together. */
const cancelTimeout = 10_000;

/** What a failure says in place of the session URI, which is a credential for a week. */
const sessionPlaceholder = "<session URI>";

/** The `Range` of a `308`, which always starts at the first byte of the object. */
const persistedRange = /^bytes=0-(\d+)$/u;

const utf8 = new TextEncoder();

/**
 * Spec 9.6: the start carries the credential and the object's resource, and answers with the
 * session URI every later request goes to. It is repeated as `CreateMultipartUpload` is on
 * S3: a session an earlier attempt created stays unseen until it expires.
 */
export async function startSession(
  configuration: GcsConfiguration,
  start: SessionStart,
): Promise<ResumableSession> {
  const response = await send(configuration, {
    method: "POST",
    operation: "put",
    key: start.key,
    path: uploadPath(configuration),
    query: [["uploadType", "resumable"]],
    headers: [["content-type", "application/json; charset=UTF-8"]],
    body: utf8.encode(start.resource),
    signal: start.signal,
    session: true,
  });

  await response.body?.cancel();

  const uri = response.headers.get("location");

  // The value is not named even where it is no URL: it may still be the credential.
  if (uri === null || URL.parse(uri) === null) {
    throw malformedAnswer(
      {
        bucket: configuration.bucket,
        operation: "put",
        key: start.key,
        subject: "the start of the upload",
        response,
      },
      "no session URI",
    );
  }

  return new ResumableSession(configuration, start.key, uri);
}

/**
 * One resumable session, whose URI never leaves this class: every failure that passes
 * through it has the URI cut out of its message and loses its cause (spec 9.6).
 */
export class ResumableSession {
  readonly #configuration: GcsConfiguration;
  readonly #key: string;
  readonly #uri: string;
  readonly #secrets: readonly string[];

  constructor(configuration: GcsConfiguration, key: string, uri: string) {
    this.#configuration = configuration;
    this.#key = key;
    this.#uri = uri;
    // The upload id alone authorizes the session too, and a runtime may print the URI in
    // a normalized form that holds it unchanged.
    this.#secrets = [uri, URL.parse(uri)?.searchParams.get("upload_id") ?? ""].filter(
      (secret) => secret !== "",
    );
  }

  /**
   * Sends a part that does not commit, until its last byte is acknowledged. A `308` whose
   * range ends inside the part is progress, and the rest goes from the buffer without
   * spending an attempt; one that acknowledges nothing new is a failed attempt (spec 9.6).
   */
  async send(chunk: Chunk, signal: AbortSignal): Promise<void> {
    await this.#sendUntilSettled(chunk, signal);
  }

  /** Sends the chunk that names the total, and resolves with the object it committed. */
  async commit(
    chunk: Chunk & { readonly total: number },
    signal?: AbortSignal,
  ): Promise<ObjectStat> {
    const committed = await this.#sendUntilSettled(chunk, signal);

    if (committed === undefined) throw new Error("A chunk that names the total settles committed");

    return committed;
  }

  /**
   * Spec 9.6: the `DELETE` that ends a session, under a timeout of its own, since the caller's
   * signal may be the one that just fired. `499` answers an open session and a `200` with the
   * object a committed one, which `readCommitted` has read. A failure of the cancel is not
   * reported: the failure that led here is what the caller is owed.
   */
  async cancel(readCommitted: boolean): Promise<ObjectStat | undefined> {
    const timeout = new AbortController();
    const timer = setTimeout(() => {
      timeout.abort();
    }, cancelTimeout);

    try {
      return await withRetry(
        async () =>
          await this.#redacting(async () => {
            const response = await sendToSession(this.#configuration, {
              method: "DELETE",
              key: this.#key,
              uri: this.#uri,
              signal: timeout.signal,
            });

            if (readCommitted) return await this.#describe(response);

            await response.body?.cancel();

            return undefined;
          }),
        { maxAttempts: this.#configuration.maxAttempts, signal: timeout.signal },
      );
    } catch {
      return undefined;
    } finally {
      clearTimeout(timer);
    }
  }

  /**
   * The chunk repeated as it was sent on the budget of spec 9.5, from the first byte the
   * session has not acknowledged: GCS ignores persisted bytes sent again, so a chunk whose
   * answer was lost goes again whole, and no status query is ever sent.
   */
  async #sendUntilSettled(chunk: Chunk, signal?: AbortSignal): Promise<ObjectStat | undefined> {
    let acknowledged = 0;

    return await withRetry(
      async () =>
        await this.#redacting(async () => {
          for (;;) {
            const rest = chunk.bytes.subarray(acknowledged);
            // oxlint-disable-next-line no-await-in-loop -- the acknowledgement decides the rest
            const response = await sendToSession(this.#configuration, {
              method: "PUT",
              key: this.#key,
              uri: this.#uri,
              headers: [
                ["content-range", contentRange(chunk.offset + acknowledged, rest, chunk.total)],
              ],
              body: rest,
              signal,
            });

            // oxlint-disable-next-line no-await-in-loop -- the object ends the loop
            if (response.status !== resumeIncomplete) return await this.#committed(chunk, response);

            // oxlint-disable-next-line no-await-in-loop -- the connection goes to the next chunk
            await response.body?.cancel();

            const persisted = this.#persistedOf(chunk, response);
            const progressed = persisted > acknowledged;

            acknowledged = persisted;

            if (!progressed) throw this.#nothingPersisted(response);
            if (acknowledged === chunk.bytes.byteLength && chunk.total === undefined) {
              return undefined;
            }
          }
        }),
      { maxAttempts: this.#configuration.maxAttempts, signal },
    );
  }

  /**
   * How many bytes of the chunk the session holds. A range that ends before the chunk or
   * beyond it has lost bytes the adapter let go of, or claims bytes it never sent.
   */
  #persistedOf(chunk: Chunk, response: Response): number {
    const range = response.headers.get("range");
    const persistedEnd =
      range === null ? 0 : Number(persistedRange.exec(range)?.[1] ?? Number.NaN) + 1;
    const persisted = persistedEnd - chunk.offset;

    if (Number.isNaN(persisted) || persisted < 0 || persisted > chunk.bytes.byteLength) {
      throw gcsError(this.#configuration.bucket, {
        code: "ProviderError",
        message: `The session acknowledged a range outside the bytes it was sent: ${range ?? "none"} for bytes from ${chunk.offset} to ${chunk.offset + chunk.bytes.byteLength}`,
        operation: "put",
        key: this.#key,
        attempts: 1,
        status: response.status,
      });
    }

    return persisted;
  }

  async #committed(chunk: Chunk, response: Response): Promise<ObjectStat> {
    if (chunk.total === undefined) {
      await response.body?.cancel();

      throw malformedAnswer(
        this.#answered(response),
        "a committed object before the total was named",
      );
    }

    return await this.#describe(response);
  }

  async #describe(response: Response): Promise<ObjectStat> {
    const { bucket } = this.#configuration;
    const resource = await readResource(bucket, this.#key, "put", response);

    return describeResource(bucket, this.#key, "put", response, resource);
  }

  // Spec 9.6: a session that stops moving ends the upload on the part's budget rather than
  // looping, so the `308` is a transient failure the next attempt may get past.
  #nothingPersisted(response: Response): StorageError {
    return gcsError(this.#configuration.bucket, {
      code: "ProviderError",
      message: "The session acknowledged nothing of the chunk beyond what it held before",
      operation: "put",
      key: this.#key,
      attempts: 1,
      status: response.status,
      retryable: true,
    });
  }

  #answered(response: Response): AnsweredRequest {
    return {
      bucket: this.#configuration.bucket,
      operation: "put",
      key: this.#key,
      subject: "a chunk of the upload",
      response,
    };
  }

  async #redacting<T>(request: () => Promise<T>): Promise<T> {
    try {
      return await request();
    } catch (failure) {
      if (!isStorageError(failure)) throw failure;

      throw withoutSecrets(failure, this.#secrets, sessionPlaceholder);
    }
  }
}

/**
 * Spec 9.6: `/*` where the total is not known yet, and an empty chunk, the commit after a
 * full last part, naming the total alone.
 */
function contentRange(first: number, bytes: Uint8Array, total: number | undefined): string {
  const size = total === undefined ? "*" : String(total);

  if (bytes.byteLength === 0) return `bytes */${size}`;

  return `bytes ${first}-${first + bytes.byteLength - 1}/${size}`;
}
