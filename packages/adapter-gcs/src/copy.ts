import { isStorageError, type ObjectStat, type StorageError, withRetry } from "@stowage/core";

import { type AnsweredRequest, malformedAnswer, readAnswerJson } from "./answer.ts";
import type { GcsConfiguration } from "./configuration.ts";
import { describeResource, readResource } from "./description.ts";
import { fieldOf, stringOf } from "./json.ts";
import {
  encodeSegment,
  type GcsRequest,
  objectPath,
  type QueryParameter,
  send,
  sendOnce,
} from "./request.ts";
import { countingAttempts, isMissingObject } from "./storage-error.ts";

/**
 * Spec 9.7 and ADR 0037: `rewriteTo` sent again with each answer's token until one says the
 * rewrite is done. The token pins the source's generation, so nothing is sent in front of the
 * first call, and each call is one request on a budget of its own.
 */
export async function copyObject(
  configuration: GcsConfiguration,
  from: string,
  to: string,
  signal: AbortSignal | undefined,
): Promise<ObjectStat> {
  let rewriteToken: string | undefined;

  for (;;) {
    // oxlint-disable-next-line no-await-in-loop -- each call continues from the answer before it
    const response = await send(configuration, {
      method: "POST",
      operation: "copy",
      key: from,
      path: `${objectPath(configuration, from)}/rewriteTo/b/${encodeSegment(configuration.bucket)}/o/${encodeSegment(to)}`,
      query: continuedFrom(rewriteToken),
      signal,
    });
    const answered: AnsweredRequest = {
      bucket: configuration.bucket,
      operation: "copy",
      key: from,
      subject: `the copy of ${JSON.stringify(from)}`,
      response,
    };
    // oxlint-disable-next-line no-await-in-loop -- the answer decides whether another call follows
    const answer = await readAnswerJson(answered);

    if (fieldOf(answer, "done") === true) {
      const resource = fieldOf(answer, "resource");

      if (resource === undefined) {
        throw malformedAnswer(answered, "a finished rewrite and no object");
      }

      return describeResource(configuration.bucket, to, "copy", response, resource);
    }

    rewriteToken = stringOf(fieldOf(answer, "rewriteToken"));

    if (rewriteToken === undefined) {
      throw malformedAnswer(answered, "an unfinished rewrite and no token to continue with");
    }

    // Spec 9.7: no budget spans the copy, so the caller's signal is what ends a long one.
    signal?.throwIfAborted();
  }
}

function continuedFrom(rewriteToken: string | undefined): readonly QueryParameter[] {
  return rewriteToken === undefined ? [] : [["rewriteToken", rewriteToken]];
}

/**
 * Spec 9.7: one `objects.move`, repeated on the budget of spec 9.5. A move that happened and
 * whose answer was lost answers `404` for its source when sent again, so a `404` after an
 * attempt the move may have happened in rejects with that attempt's failure (ADR 0037).
 */
export async function moveObject(
  configuration: GcsConfiguration,
  from: string,
  to: string,
  signal: AbortSignal | undefined,
): Promise<ObjectStat> {
  const request: GcsRequest = {
    method: "POST",
    operation: "move",
    key: from,
    path: `${objectPath(configuration, from)}/moveTo/o/${encodeSegment(to)}`,
    signal,
  };
  let attempts = 0;
  let unsettled: StorageError | undefined;
  let response: Response;

  try {
    response = await withRetry(
      async () => {
        try {
          return await sendOnce(configuration, request);
        } catch (failure) {
          if (!isStorageError(failure)) throw failure;

          attempts += failure.attempts;

          if (unsettled !== undefined && isMissingObject(failure)) {
            throw new AmbiguousMove(unsettled);
          }

          if (mayHaveMoved(failure)) unsettled = failure;

          throw failure;
        }
      },
      { maxAttempts: configuration.maxAttempts, signal },
    );
  } catch (failure) {
    if (failure instanceof AmbiguousMove) throw countingAttempts(failure.unsettled, attempts);

    throw failure;
  }

  const resource = await readResource(configuration.bucket, to, "move", response);

  return describeResource(configuration.bucket, to, "move", response, resource);
}

/**
 * What ends the loop of `withRetry` without being repeated, since it is no `StorageError`,
 * and carries the failure `move` rejects with instead of the `404`.
 */
class AmbiguousMove extends Error {
  readonly unsettled: StorageError;

  constructor(unsettled: StorageError) {
    super("The move may have happened in an earlier attempt");
    this.unsettled = unsettled;
  }
}

/**
 * An attempt that received no response or a `5xx`. A resolver's `NetworkError` counts as
 * well although no request went out, which reports the doubt where there was none rather
 * than `NotFound` for an object that may have moved (ADR 0037).
 */
function mayHaveMoved(failure: StorageError): boolean {
  return failure.code === "NetworkError" || (failure.status ?? 0) >= 500;
}
