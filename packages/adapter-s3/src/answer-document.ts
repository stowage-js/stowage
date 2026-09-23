import type { StorageError } from "@stowage/core";

import { readEmbeddedFailure } from "./provider-code.ts";
import { s3Error } from "./storage-error.ts";
import { parseXml, type XmlElement, XmlSyntaxError } from "./xml.ts";

/** The request a document answered, which a failure read out of it is told against. */
export interface AnsweredRequest {
  readonly bucket: string;
  readonly operation: string;
  readonly key?: string;
  /** What the answer is about, for a message: "the deletion", "the copy". */
  readonly subject: string;
}

/**
 * The root of the document a `200` carries, read through the parser of spec 7.4. S3 may
 * answer a `CopyObject` or a `DeleteObjects` with `200` and an `<Error>` in the body once
 * the answer has begun, so a root of that name is the failure it reports, told with the
 * provider's code and message, and not repeated (ADR 0013 lets no code into the group).
 */
export async function readAnswerDocument(
  request: AnsweredRequest,
  response: Response,
  expectedRoot: string,
): Promise<XmlElement> {
  const requestId = response.headers.get("x-amz-request-id") ?? undefined;
  const told = {
    operation: request.operation,
    key: request.key,
    attempts: 1,
    status: response.status,
    requestId,
  };
  const root = parseAnswer(request, await readBody(request, response, told), told);

  if (root.name === "Error") {
    const providerCode = textOf(root, "Code") ?? "";
    const failure = readEmbeddedFailure(
      providerCode,
      textOf(root, "Message") ?? `The provider failed ${request.subject}: ${providerCode}`,
    );

    throw s3Error(request.bucket, {
      ...told,
      code: failure.code,
      message: failure.message,
      providerCode: providerCode === "" ? undefined : providerCode,
      retryable: failure.retryable,
    });
  }

  if (root.name !== expectedRoot) {
    throw malformed(request, told, `a <${root.name}> where a <${expectedRoot}> belongs`);
  }

  return root;
}

export function textOf(element: XmlElement, name: string): string | undefined {
  return element.children.find((child) => child.name === name)?.text;
}

type Told = Pick<StorageError, "operation" | "key" | "attempts" | "status" | "requestId">;

async function readBody(request: AnsweredRequest, response: Response, told: Told): Promise<string> {
  try {
    return await response.text();
  } catch (failure) {
    // Spec 4.10: the caller's abort travels on as the runtime's `AbortError`.
    if (failure instanceof Error && failure.name === "AbortError") throw failure;

    throw s3Error(request.bucket, {
      ...told,
      code: "NetworkError",
      message: `The answer to ${request.subject} broke while it was read: ${String(failure)}`,
      retryable: true,
      cause: failure,
    });
  }
}

function parseAnswer(request: AnsweredRequest, body: string, told: Told): XmlElement {
  try {
    return parseXml(body);
  } catch (failure) {
    if (failure instanceof XmlSyntaxError) {
      throw malformed(
        request,
        told,
        `a document outside the XML stowage reads: ${failure.message}`,
        failure,
      );
    }

    throw failure;
  }
}

function malformed(
  request: AnsweredRequest,
  told: Told,
  what: string,
  cause?: unknown,
): StorageError {
  return s3Error(request.bucket, {
    ...told,
    code: "ProviderError",
    message: `The provider answered ${request.subject} with ${what}`,
    cause,
  });
}
