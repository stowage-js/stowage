import type { ObjectStat } from "@stowage/core";

import { type AnsweredRequest, malformedAnswer, readAnswerJson } from "./answer.ts";
import type { GcsConfiguration } from "./configuration.ts";
import { describeResource, readResource } from "./description.ts";
import { fieldOf, stringOf } from "./json.ts";
import { preconditionQuery, preconditionRule, type WritePrecondition } from "./precondition.ts";
import { encodeSegment, objectPath, type QueryParameter, send } from "./request.ts";

/** What `copy` and `move` write, and the precondition of `to` they write under. */
export interface ObjectCopy {
  readonly from: string;
  readonly to: string;
  readonly onlyIf?: WritePrecondition;
  readonly signal?: AbortSignal;
}

/**
 * Spec 9.7 and ADR 0037: `rewriteTo` sent again with each answer's token until one says the
 * rewrite is done. The token pins the source's generation, so nothing is sent in front of the
 * first call, and each call is one request on a budget of its own.
 *
 * Every call carries the precondition. GCS holds the first call's through the rewrite and
 * checks it at the call that commits, so a key another writer took in between is refused
 * there and nothing is left behind (spec 9.4).
 */
export async function copyObject(
  configuration: GcsConfiguration,
  { from, to, onlyIf, signal }: ObjectCopy,
): Promise<ObjectStat> {
  let rewriteToken: string | undefined;

  for (;;) {
    // oxlint-disable-next-line no-await-in-loop -- each call continues from the answer before it
    const response = await send(configuration, {
      method: "POST",
      operation: "copy",
      key: from,
      destination: to,
      path: `${objectPath(configuration, from)}/rewriteTo/b/${encodeSegment(configuration.bucket)}/o/${encodeSegment(to)}`,
      query: [...continuedFrom(rewriteToken), ...preconditionQuery(onlyIf)],
      precondition: preconditionRule(onlyIf),
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
 * attempt the move may have happened in rejects with that attempt's failure (ADR 0037), and
 * so does a refusal of its precondition, which then meets the moved object (ADR 0073). A move
 * its precondition refused leaves both keys as they were.
 */
export async function moveObject(
  configuration: GcsConfiguration,
  { from, to, onlyIf, signal }: ObjectCopy,
): Promise<ObjectStat> {
  const response = await send(configuration, {
    method: "POST",
    operation: "move",
    key: from,
    destination: to,
    path: `${objectPath(configuration, from)}/moveTo/o/${encodeSegment(to)}`,
    query: preconditionQuery(onlyIf),
    unanswered: "reportOverNotFound",
    precondition: preconditionRule(onlyIf),
    signal,
  });
  const resource = await readResource(configuration.bucket, to, "move", response);

  return describeResource(configuration.bucket, to, "move", response, resource);
}
