import type { ObjectStat, Storage } from "@stowage/core";

import { answerFor, methodNotAllowed } from "./answers.ts";
import { contentDisposition, lastSegmentOf } from "./disposition.ts";

export interface ServeObjectOptions {
  /** The name a download is saved under; the key's last segment where it is absent. */
  filename?: string;
  /**
   * `"attachment"`, the default, has a browser save the object. `"inline"` has it shown
   * from the application's origin with that origin's rights, which `nosniff` does not
   * prevent for an uploaded `text/html` or `image/svg+xml`: the caller's choice and risk.
   */
  disposition?: "attachment" | "inline";
  /** Replaces the `Cache-Control: private, no-cache` every answer carries otherwise. */
  cacheControl?: string;
}

/**
 * Answers `GET` with the object streamed from `get`, and `HEAD` from `stat` with the same
 * headers and no body (spec 10.3). Any other method is `405`.
 */
export async function serveObject(
  storage: Storage,
  key: string,
  request: Request,
  options: ServeObjectOptions = {},
): Promise<Response> {
  // Hono and Next.js route `HEAD` to the `GET` handler, so the method is read here and
  // not left to the router.
  const method = request.method;

  if (method !== "GET" && method !== "HEAD") return methodNotAllowed("GET, HEAD");

  const signal = request.signal;

  try {
    if (method === "HEAD") {
      const stat = await storage.stat(key, { signal });

      return new Response(null, {
        status: 200,
        headers: objectHeaders(storage, key, stat, options),
      });
    }

    const object = await storage.get(key, { signal });

    // No `Content-Length`: an object another tool stored with a content coding may arrive
    // decoded and longer than `size`, and Node and Deno would cut such a body to `size`
    // and end the response as complete.
    return new Response(object.stream(), {
      status: 200,
      headers: objectHeaders(storage, key, object.stat, options),
    });
  } catch (thrown) {
    return answerFor(thrown);
  }
}

function objectHeaders(
  storage: Storage,
  key: string,
  stat: ObjectStat,
  options: ServeObjectOptions,
): Headers {
  const headers = new Headers({
    "content-type": stat.contentType,
    "x-content-type-options": "nosniff",
    "content-disposition": contentDisposition(
      options.disposition ?? "attachment",
      options.filename ?? lastSegmentOf(key),
    ),
    "cache-control": options.cacheControl ?? "private, no-cache",
    "last-modified": lastModifiedOf(stat),
  });

  // A storage that hands over no `etag`, `adapter-fs`, gets none derived for it: a tag
  // built from size and time would claim a strength the layer cannot vouch for.
  if (stat.etag !== undefined) headers.set("etag", `"${stat.etag}"`);
  if (storage.capabilities.includes("rangeReads")) headers.set("accept-ranges", "bytes");

  return headers;
}

/**
 * At whole seconds, and never later than the response's own date: RFC 9110 8.8.2 has a
 * server send no `Last-Modified` in its future, which a provider's clock ahead of the
 * server's would otherwise produce.
 */
function lastModifiedOf(stat: ObjectStat): string {
  const second = 1000;
  const modified = Math.floor(stat.lastModified.getTime() / second) * second;
  const now = Math.floor(Date.now() / second) * second;

  return new Date(Math.min(modified, now)).toUTCString();
}
