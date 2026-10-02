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
import { lastModifiedOf } from "./http-date.ts";
import { type Preconditions, preconditionsOf, verdictOf } from "./preconditions.ts";
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

  const serving: ServeRequest = { storage, key, signal: request.signal, options };
  const preconditions = preconditionsOf(request.headers);

  try {
    if (method === "HEAD") {
      const stat = await storage.stat(key, { signal: serving.signal });

      return (
        failedPrecondition(serving, preconditions, stat) ??
        new Response(null, { status: 200, headers: objectHeaders(serving, stat) })
      );
    }

    if (preconditions !== undefined) {
      const stat = await storage.stat(key, { signal: serving.signal });
      const failed = failedPrecondition(serving, preconditions, stat);

      if (failed !== undefined) return failed;
    }

    const requested = storage.capabilities.includes("rangeReads")
      ? requestedRangeOf(request.headers.get("range"))
      : undefined;

    return requested === undefined
      ? await serveWhole(serving)
      : await serveRequested(serving, requested);
  } catch (thrown) {
    return answerFor(thrown);
  }
}

/** One `GET` or `HEAD` the layer answers, as `serveObject` was called for it. */
interface ServeRequest {
  readonly storage: Storage;
  readonly key: string;
  readonly signal: AbortSignal;
  readonly options: ServeObjectOptions;
}

async function serveWhole(serving: ServeRequest): Promise<Response> {
  const object = await serving.storage.get(serving.key, { signal: serving.signal });

  // No `Content-Length`: an object another tool stored with a content coding may arrive
  // decoded and longer than `size`, and Node and Deno would cut such a body to `size`
  // and end the response as complete.
  return new Response(object.stream(), {
    status: 200,
    headers: objectHeaders(serving, object.stat),
  });
}

/**
 * The one range asked for. Only a suffix needs the size before `get` (ADR 0048); RFC 9110
 * 14.1.2 makes an empty suffix unsatisfiable, and any other suffix of an empty object the
 * whole of it, which no `Content-Range` can name.
 */
async function serveRequested(serving: ServeRequest, requested: RequestedRange): Promise<Response> {
  if (!("suffixLength" in requested)) return await serveRange(serving, requested);

  const { size } = await serving.storage.stat(serving.key, { signal: serving.signal });

  if (requested.suffixLength === 0) return rangeNotSatisfiable(size);
  if (size === 0) return await serveWhole(serving);

  return await serveRange(serving, suffixOf(requested.suffixLength, size));
}

/** A `206` whose `Content-Range` follows the `stat` of `get`, which describes the bytes sent. */
async function serveRange(serving: ServeRequest, range: ByteRange): Promise<Response> {
  const { storage, key, signal } = serving;
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
    if (thrown.code === "ProviderError" && !thrown.retryable) return await serveWhole(serving);

    throw thrown;
  }

  const { size } = object.stat;
  const last = lastByteOf(range, size);
  const headers = objectHeaders(serving, object.stat);

  // A ranged `get` never hands over an object stored with a content coding (ADR 0044),
  // so the length holds here where a `200` could not carry one.
  headers.set("content-range", `bytes ${range.start}-${last}/${size}`);
  headers.set("content-length", String(last - range.start + 1));

  return new Response(object.stream(), { status: 206, headers });
}

/** The `304` or `412` of a precondition that fails on `stat`, `undefined` where all hold. */
function failedPrecondition(
  serving: ServeRequest,
  preconditions: Preconditions | undefined,
  stat: ObjectStat,
): Response | undefined {
  const verdict = preconditions === undefined ? "perform" : verdictOf(preconditions, stat);

  if (verdict === "perform") return undefined;
  if (verdict === 412) return new Response(null, { status: 412 });

  return new Response(null, { status: 304, headers: objectHeaders(serving, stat) });
}

function objectHeaders({ storage, key, options }: ServeRequest, stat: ObjectStat): Headers {
  const headers = new Headers({
    "content-type": stat.contentType,
    "x-content-type-options": "nosniff",
    "content-disposition": contentDisposition(
      options.disposition ?? "attachment",
      options.filename ?? lastSegmentOf(key),
    ),
    "cache-control": options.cacheControl ?? "private, no-cache",
    "last-modified": lastModifiedOf(stat).toUTCString(),
  });

  // A storage that hands over no `etag`, `adapter-fs`, gets none derived for it: a tag
  // built from size and time would claim a strength the layer cannot vouch for.
  if (stat.etag !== undefined) headers.set("etag", `"${stat.etag}"`);
  if (storage.capabilities.includes("rangeReads")) headers.set("accept-ranges", "bytes");

  return headers;
}
