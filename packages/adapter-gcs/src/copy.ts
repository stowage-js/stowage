import type { ObjectStat } from "@stowage/core";

import { type AnsweredRequest, malformedAnswer, readAnswerJson } from "./answer.ts";
import type { GcsConfiguration } from "./configuration.ts";
import { describeResource } from "./description.ts";
import { fieldOf, stringOf } from "./json.ts";
import { encodeSegment, objectPath, type QueryParameter, send } from "./request.ts";

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
