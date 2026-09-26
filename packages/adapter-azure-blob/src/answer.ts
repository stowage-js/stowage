import { parseXml, type StorageError, type XmlElement, XmlSyntaxError } from "@stowage/core";

import { azureBlobError } from "./storage-error.ts";

/** A request the provider answered with success, as a failure told against its answer reads it. */
export interface AnsweredRequest {
  readonly container: string;
  readonly operation: string;
  /** What the request asked for, as a failure names it: `the listing`, `the deletion`. */
  readonly subject: string;
  readonly status: number;
  readonly requestId?: string;
}

export function answeredRequest(
  container: string,
  operation: string,
  subject: string,
  response: Response,
): AnsweredRequest {
  return {
    container,
    operation,
    subject,
    status: response.status,
    requestId: response.headers.get("x-ms-request-id") ?? undefined,
  };
}

/**
 * Spec 8.5 repeats a transport failure that received no response; this one received its
 * response and broke in the body, which spec 4.5 leaves unresumed for `get` as well.
 */
export async function readAnswerText(
  answered: AnsweredRequest,
  response: Response,
): Promise<string> {
  try {
    return await response.text();
  } catch (failure) {
    // Spec 4.10: the caller's abort travels on as the runtime's `AbortError`.
    if (failure instanceof Error && failure.name === "AbortError") throw failure;

    throw azureBlobError(answered.container, {
      code: "NetworkError",
      message: `The answer to ${answered.subject} broke while it was read: ${String(failure)}`,
      operation: answered.operation,
      attempts: 1,
      status: answered.status,
      requestId: answered.requestId,
      retryable: true,
      cause: failure,
    });
  }
}

/**
 * The document the provider answered with, read through the parser of spec 8.4. A body
 * outside the subset the parser reads is a `ProviderError` rather than a value made up.
 */
export function parseAnswer(answered: AnsweredRequest, body: string): XmlElement {
  try {
    return parseXml(body);
  } catch (failure) {
    if (failure instanceof XmlSyntaxError) {
      throw malformedAnswer(
        answered,
        `a document outside the XML stowage reads: ${failure.message}`,
        failure,
      );
    }

    throw failure;
  }
}

export function malformedAnswer(
  answered: AnsweredRequest,
  what: string,
  cause?: unknown,
): StorageError {
  return azureBlobError(answered.container, {
    code: "ProviderError",
    message: `The provider answered ${answered.subject} with ${what}`,
    operation: answered.operation,
    attempts: 1,
    status: answered.status,
    requestId: answered.requestId,
    cause,
  });
}
