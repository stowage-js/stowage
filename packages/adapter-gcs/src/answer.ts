import type { StorageError } from "@stowage/core";

import { requestIdHeader } from "./request.ts";
import { gcsError } from "./storage-error.ts";

/** A request the provider answered with success, and what reading its body is told against. */
export interface AnsweredRequest {
  readonly bucket: string;
  readonly operation: string;
  /** The key the request addressed; a listing addresses none. */
  readonly key?: string;
  /** What the answer carries, as a message names it: `the listing`, for one. */
  readonly subject: string;
  readonly response: Response;
}

/**
 * The body read to the end as JSON. A body that is no JSON is a `ProviderError` rather than
 * a value made up for what it did not carry.
 */
export async function readAnswerJson(answered: AnsweredRequest): Promise<unknown> {
  try {
    return await answered.response.json();
  } catch (failure) {
    if (failure instanceof Error && failure.name === "AbortError") throw failure;

    throw malformedAnswer(answered, "a body that is no JSON", failure);
  }
}

/**
 * The body read to the end as text. A body that breaks on the way is a `NetworkError`: the
 * request ran, and what it did is unknown.
 */
export async function readAnswerText(answered: AnsweredRequest): Promise<string> {
  try {
    return await answered.response.text();
  } catch (failure) {
    // Spec 4.10: the caller's abort travels on as the runtime's `AbortError`.
    if (failure instanceof Error && failure.name === "AbortError") throw failure;

    throw gcsError(answered.bucket, {
      code: "NetworkError",
      message: `The answer to ${answered.subject} broke while it was read: ${String(failure)}`,
      operation: answered.operation,
      key: answered.key,
      attempts: 1,
      status: answered.response.status,
      requestId: answered.response.headers.get(requestIdHeader) ?? undefined,
      retryable: true,
      cause: failure,
    });
  }
}

// Spec 4.6 makes a description or an entry that arrives without one of its parts a
// `ProviderError` rather than one with a value invented for it.
export function malformedAnswer(
  answered: AnsweredRequest,
  what: string,
  cause?: unknown,
): StorageError {
  return gcsError(answered.bucket, {
    code: "ProviderError",
    message: `The provider answered ${answered.subject} with ${what}`,
    operation: answered.operation,
    key: answered.key,
    attempts: 1,
    status: answered.response.status,
    requestId: answered.response.headers.get(requestIdHeader) ?? undefined,
    cause,
  });
}
