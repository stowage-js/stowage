import { answerFor, methodNotAllowed } from "./answers.ts";
import { dispositionOf } from "./disposition.ts";

/**
 * A storage that presigns a download, with the options every adapter declaring
 * `presignedUrls` shares (ADR 0048). It is not `Storage`, so that a storage without
 * `presignedUrls` fails to compile rather than at run time.
 */
export interface PresignsGet {
  presignGet(
    key: string,
    options: { expiresIn: number; responseContentDisposition?: string },
  ): Promise<string>;
}

export interface RedirectToObjectOptions {
  /**
   * Seconds the presigned URL holds, passed to `presignGet` as it is. A value outside the
   * adapter's bounds is its `InvalidOption`, answered `500`.
   */
  expiresIn: number;
  /** The name a download is saved under; the key's last segment where it is absent. */
  filename?: string;
  /**
   * `"attachment"`, the default, has a browser save the object, `"inline"` show it. It
   * reaches the provider with `filename` as `responseContentDisposition`.
   */
  disposition?: "attachment" | "inline";
}

/**
 * Answers `GET` and `HEAD` with the same `302` to a URL from `presignGet` (spec 10.4), which
 * leaves ranges, preconditions and a content coding to the provider. Any other method is
 * `405`. `presignGet` sends no request, so a missing key is the provider's `404`, not this.
 */
export async function redirectToObject(
  storage: PresignsGet,
  key: string,
  request: Request,
  options: RedirectToObjectOptions,
): Promise<Response> {
  const method = request.method;

  if (method !== "GET" && method !== "HEAD") return methodNotAllowed("GET, HEAD");

  let location: string;

  try {
    location = await storage.presignGet(key, {
      expiresIn: options.expiresIn,
      responseContentDisposition: dispositionOf(key, options),
    });
  } catch (thrown) {
    return answerFor(thrown);
  }

  // `Response.redirect()` would freeze the headers the caller may still change (spec 10.2),
  // and the URL expires, so no cache may keep the answer.
  return new Response(null, {
    status: 302,
    headers: { location, "cache-control": "private, no-store" },
  });
}
