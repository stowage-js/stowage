import {
  type ByteRange,
  isStorageError,
  lastByteOf,
  type ObjectStat,
  type Storage,
  type StoredObject,
} from "@stowage/core";

import { answerFor, methodNotAllowed, rangeNotSatisfiable } from "./answers.ts";
import { contentDisposition, lastSegmentOf } from "./disposition.ts";
import { type RequestedRange, requestedRangeOf, suffixOf } from "./range.ts";

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
 * headers and no body (spec 10.3). Any other method is `405`. Where the storage declares
 * `rangeReads`, one range of `bytes` is `206`, or `416` where it is unsatisfiable; any other
 * `Range` is ignored.
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

    const served: Served = { storage, key, signal, options };
    const requested = storage.capabilities.includes("rangeReads")
      ? requestedRangeOf(request.headers.get("range"))
      : undefined;

    return requested === undefined ? await serveWhole(served) : await servePart(served, requested);
  } catch (thrown) {
    return answerFor(thrown);
  }
}

interface Served {
  readonly storage: Storage;
  readonly key: string;
  readonly signal: AbortSignal;
  readonly options: ServeObjectOptions;
}

async function serveWhole({ storage, key, signal, options }: Served): Promise<Response> {
  const object = await storage.get(key, { signal });

  // No `Content-Length`: an object another tool stored with a content coding may arrive
  // decoded and longer than `size`, and Node and Deno would cut such a body to `size`
  // and end the response as complete.
  return new Response(object.stream(), {
    status: 200,
    headers: objectHeaders(storage, key, object.stat, options),
  });
}

/**
 * The one span asked for. Only a suffix needs the size before `get` (ADR 0048); RFC 9110
 * 14.1.2 makes an empty suffix unsatisfiable, and any other suffix of an empty object the
 * whole of it, which no `Content-Range` can name.
 */
async function servePart(served: Served, requested: RequestedRange): Promise<Response> {
  if (!("suffixLength" in requested)) return await serveSpan(served, requested);

  const { size } = await served.storage.stat(served.key, { signal: served.signal });

  if (requested.suffixLength === 0) return rangeNotSatisfiable(size);
  if (size === 0) return await serveWhole(served);

  return await serveSpan(served, suffixOf(requested.suffixLength, size));
}

/** A `206` whose `Content-Range` follows the `stat` of `get`, which describes the bytes sent. */
async function serveSpan(served: Served, range: ByteRange): Promise<Response> {
  const { storage, key, signal, options } = served;
  let object: StoredObject;

  try {
    object = await storage.get(key, { signal, range });
  } catch (thrown) {
    if (!isStorageError(thrown)) throw thrown;

    // Spec 4.3 refuses a start at or beyond the size without naming the size.
    if (thrown.code === "InvalidRequest") {
      return rangeNotSatisfiable((await storage.stat(key, { signal })).size, thrown);
    }

    // ADR 0048: the refused range of a content-coded object (ADR 0044), which only the
    // message tells apart from a provider's failure, and that fails the whole `get` alike.
    if (thrown.code === "ProviderError" && !thrown.retryable) return await serveWhole(served);

    throw thrown;
  }

  const { size } = object.stat;
  const last = lastByteOf(range, size);
  const headers = objectHeaders(storage, key, object.stat, options);

  // A ranged `get` never hands over an object stored with a content coding (ADR 0044),
  // so the length holds here where a `200` could not carry one.
  headers.set("content-range", `bytes ${range.start}-${last}/${size}`);
  headers.set("content-length", String(last - range.start + 1));

  return new Response(object.stream(), { status: 206, headers });
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
 * At whole seconds, and never later than now: RFC 9110 8.8.2 has a server send no
 * `Last-Modified` in its future, which a provider's clock ahead of the server's would
 * otherwise produce. The server writes its `Date` after this runs, so the cap stands in
 * for that date and never lies after it.
 */
function lastModifiedOf(stat: ObjectStat): string {
  const second = 1000;
  const modified = Math.floor(stat.lastModified.getTime() / second) * second;
  const now = Math.floor(Date.now() / second) * second;

  return new Date(Math.min(modified, now)).toUTCString();
}
