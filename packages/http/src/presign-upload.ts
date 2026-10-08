import {
  capabilityNames,
  contentHeadersRefusal,
  isHeaderValue,
  type PresignedPut,
} from "@stowage/core";

import { answerFor, refusal } from "./answers.ts";

/**
 * A storage that presigns an upload, with the options every adapter declaring
 * `presignedUrls` shares (ADR 0049). It is not `Storage`, so that a storage without
 * `presignedUrls` fails to compile rather than at run time.
 */
export interface PresignsPut {
  presignPut(
    key: string,
    options: {
      expiresIn: number;
      contentType: string;
      contentLength: number;
      cacheControl?: string;
      contentDisposition?: string;
      contentLanguage?: string;
    },
  ): Promise<PresignedPut>;
}

export interface PresignUploadOptions {
  /**
   * Seconds the presigned URL holds, passed to `presignPut` as it is. A value outside the
   * adapter's bounds is its `InvalidOption`, answered `500`.
   */
  expiresIn: number;
  /** The most bytes the upload may announce: a `contentLength` above it is `413`. */
  maxSize: number;
  /**
   * The content type the client sent, which the signature binds. An empty value or one that
   * is no valid header value is `400` before signing.
   */
  contentType: string;
  /**
   * The length the client sent, which the signature binds. A value that is no non-negative
   * integer is `400` before signing.
   */
  contentLength: number;
  /**
   * The `Cache-Control` the signature binds, passed to `presignPut` where given. The layer
   * never reads it from a request. A value outside the form or the bounds `put` checks the
   * three by is `400` before signing, as is each of the other two.
   */
  cacheControl?: string;
  /** The `Content-Disposition` the signature binds, passed to `presignPut` where given. */
  contentDisposition?: string;
  /** The `Content-Language` the signature binds, passed to `presignPut` where given. */
  contentLanguage?: string;
}

/**
 * Answers with what `presignPut` returns, as JSON (spec 10.6). It takes no `Request`: the
 * caller names the key first, usually from the request body, and hands over the values the
 * client sent (ADR 0049).
 */
export async function presignUpload(
  storage: PresignsPut,
  key: string,
  options: PresignUploadOptions,
): Promise<Response> {
  const { contentType, contentLength } = options;

  // The client's values arrive unchecked by any type, and an adapter refusing one would
  // answer `500` for what is the client's mistake.
  if (typeof contentLength !== "number" || !Number.isInteger(contentLength) || contentLength < 0) {
    return refusal(400);
  }

  if (contentLength > options.maxSize) return refusal(413);
  if (typeof contentType !== "string" || !isHeaderValue(contentType)) return refusal(400);

  // Every capability is assumed, so that only the client's value is refused here: a storage
  // that holds no content headers is the caller's, and its own refusal answers `500`.
  if (contentHeadersRefusal(options, contentType, capabilityNames) !== undefined) {
    return refusal(400);
  }

  let presigned: PresignedPut;

  try {
    presigned = await storage.presignPut(key, {
      expiresIn: options.expiresIn,
      contentType,
      contentLength,
      cacheControl: options.cacheControl,
      contentDisposition: options.contentDisposition,
      contentLanguage: options.contentLanguage,
    });
  } catch (thrown) {
    return answerFor(thrown);
  }

  const { url, headers } = presigned;

  return new Response(JSON.stringify({ url, method: "PUT", headers }), {
    status: 200,
    headers: { "content-type": "application/json", "cache-control": "private, no-store" },
  });
}
