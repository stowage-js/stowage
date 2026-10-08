import {
  type ByteRange,
  isStorageError,
  lastByteOf,
  type ObjectStat,
  type Storage,
  type StoredObject,
} from "@stowage/core";

import { answerFor, methodNotAllowed, rangeNotSatisfiable } from "./answers.ts";
import { dispositionOf, isAttachment } from "./disposition.ts";
import { lastModifiedOf } from "./http-date.ts";
import {
  type FailedPrecondition,
  failedPreconditionOf,
  isFailedPrecondition,
  type Preconditions,
  preconditionsOf,
  rangeHolds,
} from "./preconditions.ts";
import { type RequestedRange, requestedRangeOf, suffixOf } from "./range.ts";

export interface ServeObjectOptions {
  /**
   * The name a download is saved under. Where neither it nor `disposition` is given, an
   * object stored with an `attachment` disposition is served with that one, and any other
   * with the key's last segment.
   */
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
 * `rangeReads`, one range of `bytes` of an object without `contentEncoding` is `206`, or
 * `416` where it is unsatisfiable; any other `Range` is ignored. The preconditions of
 * RFC 9110 13.2.2 answer `304` or `412` where one fails, and `If-Range` sends the whole
 * object for anything but the strong `ETag`.
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

  const serving: ServeRequest = {
    storage,
    key,
    method,
    signal: request.signal,
    options,
    answeredAt: Date.now(),
  };
  const preconditions = preconditionsOf(request.headers);

  try {
    if (method === "HEAD") {
      const stat = await storage.stat(key, { signal: serving.signal });
      const failed = failedPreconditionOf(preconditions, stat);

      return failed === undefined
        ? new Response(null, { status: 200, headers: wholeHeaders(serving, stat) })
        : failedAnswer(serving, failed, stat);
    }

    const requested = storage.capabilities.includes("rangeReads")
      ? requestedRangeOf(request.headers.get("range"))
      : undefined;
    // RFC 9110 13.1.5: `If-Range` counts only beside a range the layer would serve.
    const ifRange =
      requested === undefined ? undefined : (request.headers.get("if-range") ?? undefined);

    if (preconditions === undefined && ifRange === undefined) {
      if (requested === undefined) return await serveWhole(serving);
      if (!("suffixLength" in requested)) return await serveRange(serving, requested);
    }

    const stat = await storage.stat(key, { signal: serving.signal });
    const asked: Asked = { preconditions, requested, ifRange };

    return await servePlanned(serving, {
      stat,
      decide: (each) => planOf(asked, each),
    });
  } catch (thrown) {
    return answerFor(thrown);
  }
}

/** One `GET` or `HEAD` the layer answers, as `serveObject` was called for it. */
interface ServeRequest {
  readonly storage: Storage;
  readonly key: string;
  readonly method: "GET" | "HEAD";
  readonly signal: AbortSignal;
  readonly options: ServeObjectOptions;
  /**
   * The time the answer sends as its `Date` and caps `Last-Modified` at. Bun and Deno write
   * a `Date` of their own up to a second behind their clock, which could lie before a
   * `Last-Modified` capped at that clock; a `Date` the answer carries, every server keeps.
   */
  readonly answeredAt: number;
}

/** What a `GET` asks beyond the object, which a `stat` decides (ADR 0048). */
interface Asked {
  readonly preconditions: Preconditions | undefined;
  readonly requested: RequestedRange | undefined;
  readonly ifRange: string | undefined;
}

/** The answer a `GET` gets from one `stat`, the range a `206` sends with it. */
type Plan =
  | { readonly status: 304 | 412 | 416 | 200 }
  | { readonly status: 206; readonly range: ByteRange };

/**
 * RFC 9110 13.2.2, the range last. Only a suffix needs the size; RFC 9110 14.1.2 makes an
 * empty suffix unsatisfiable, and any other suffix of an empty object the whole of it,
 * which no `Content-Range` can name. A coded object takes no range at all (ADR 0044), so
 * its `Range` is ignored, an empty suffix included, and no ranged `get` is sent to fail.
 */
function planOf({ preconditions, requested, ifRange }: Asked, stat: ObjectStat): Plan {
  const failed = failedPreconditionOf(preconditions, stat);

  if (failed !== undefined) return { status: failed };
  if (requested === undefined || stat.contentEncoding !== undefined) return { status: 200 };
  if (!rangeHolds(ifRange, stat)) return { status: 200 };
  if (!("suffixLength" in requested)) return { status: 206, range: requested };
  if (requested.suffixLength === 0) return { status: 416 };
  if (stat.size === 0) return { status: 200 };

  return { status: 206, range: suffixOf(requested.suffixLength, stat.size) };
}

/**
 * The `stat` a plan is made from before `get`, and how to make it again from the `stat`
 * of `get`, which describes the bytes sent (ADR 0048).
 */
interface Planning {
  readonly stat: ObjectStat;
  readonly decide: (stat: ObjectStat) => Plan;
}

async function servePlanned(serving: ServeRequest, planning: Planning): Promise<Response> {
  const plan = planning.decide(planning.stat);

  switch (plan.status) {
    case 200:
      return await serveWhole(serving, planning);
    case 206:
      return await serveRange(serving, plan.range, planning);
    case 416:
      return rangeNotSatisfiable(planning.stat.size);
    default:
      return failedAnswer(serving, plan.status, planning.stat);
  }
}

/**
 * The plan for an object `get` handed over in place of the one planned on, `undefined`
 * where it is that one. Spec 10.3: the `etag`s tell a changed object, and without them
 * `size` and `lastModified`.
 */
function changedPlanOf(planning: Planning | undefined, handed: ObjectStat): Plan | undefined {
  if (planning === undefined) return undefined;

  const { stat: seen } = planning;
  const changed =
    seen.etag !== undefined && handed.etag !== undefined
      ? seen.etag !== handed.etag
      : seen.size !== handed.size || seen.lastModified.getTime() !== handed.lastModified.getTime();

  return changed ? planning.decide(handed) : undefined;
}

/** The answer of a failed precondition: `304` with the headers of a `200`, or `412`. */
function failedAnswer(
  serving: ServeRequest,
  status: FailedPrecondition,
  stat: ObjectStat,
): Response {
  return status === 304
    ? new Response(null, { status, headers: objectHeaders(serving, stat) })
    : new Response(null, {
        status,
        headers:
          serving.method === "HEAD"
            ? { date: new Date(serving.answeredAt).toUTCString() }
            : undefined,
      });
}

async function serveWhole(serving: ServeRequest, planning?: Planning): Promise<Response> {
  const object = await serving.storage.get(serving.key, { signal: serving.signal });
  const changed = changedPlanOf(planning, object.stat)?.status;

  // Any other plan still takes the whole object, which RFC 9110 14.2 lets a server send
  // for a range it would otherwise serve.
  if (changed !== undefined && isFailedPrecondition(changed)) {
    await discard(object);

    return failedAnswer(serving, changed, object.stat);
  }

  return new Response(object.stream(), {
    status: 200,
    headers: wholeHeaders(serving, object.stat),
  });
}

/** A `206` whose `Content-Range` follows the `stat` of `get`, which describes the bytes sent. */
async function serveRange(
  serving: ServeRequest,
  range: ByteRange,
  planning?: Planning,
): Promise<Response> {
  const { storage, key, signal } = serving;
  let object: StoredObject;

  try {
    object = await storage.get(key, { signal, range });
  } catch (thrown) {
    if (!isStorageError(thrown)) throw thrown;

    // Spec 4.3 refuses a start at or beyond the size without naming the size.
    if (thrown.code === "InvalidRequest") {
      const stat = await storage.stat(key, { signal });
      const changed = changedPlanOf(planning, stat);

      if (planning !== undefined && changed !== undefined && !sendsRange(changed, range)) {
        return isFailedPrecondition(changed.status)
          ? failedAnswer(serving, changed.status, stat)
          : await serveWhole(serving, { ...planning, stat });
      }

      return rangeNotSatisfiable(stat.size, thrown);
    }

    // ADR 0048: the refused range of a content-coded object (ADR 0044), which only the
    // message tells apart from a provider's failure, and that fails the whole `get` alike.
    if (thrown.code === "ProviderError" && !thrown.retryable) {
      return await serveWhole(serving, planning);
    }

    throw thrown;
  }

  const changed = changedPlanOf(planning, object.stat);

  if (planning !== undefined && changed !== undefined && !sendsRange(changed, range)) {
    await discard(object);

    // Spec 10.3: at most one more `get`, and a whole one, decided again by its own `stat`.
    return isFailedPrecondition(changed.status)
      ? failedAnswer(serving, changed.status, object.stat)
      : await serveWhole(serving, { ...planning, stat: object.stat });
  }

  const { size } = object.stat;
  const last = lastByteOf(range, size);
  const headers = objectHeaders(serving, object.stat);

  // A ranged `get` never hands over an object stored with a content coding (ADR 0044),
  // so the length holds here for every object a `206` is sent for.
  headers.set("content-range", `bytes ${range.start}-${last}/${size}`);
  headers.set("content-length", String(last - range.start + 1));

  return new Response(object.stream(), { status: 206, headers });
}

function sendsRange(plan: Plan, range: ByteRange): boolean {
  return plan.status === 206 && plan.range.start === range.start && plan.range.end === range.end;
}

/** Cancels the body of an object the answer does not send, which reaches the provider. */
async function discard(object: StoredObject): Promise<void> {
  await object
    .stream()
    .cancel()
    .catch(() => {});
}

/**
 * The headers of a `200` and of its `HEAD`. A coded object may arrive decoded and longer
 * than `size`, which Node and Deno would cut to a declared length and end as complete
 * (ADR 0062), so only an object without `contentEncoding` gets one.
 */
function wholeHeaders(serving: ServeRequest, stat: ObjectStat): Headers {
  const headers = objectHeaders(serving, stat);

  if (stat.contentEncoding === undefined) headers.set("content-length", String(stat.size));

  return headers;
}

function objectHeaders(
  { storage, key, options, answeredAt }: ServeRequest,
  stat: ObjectStat,
): Headers {
  const headers = new Headers({
    date: new Date(answeredAt).toUTCString(),
    "content-type": stat.contentType,
    "x-content-type-options": "nosniff",
    "content-disposition": contentDispositionOf(key, options, stat),
    "cache-control": options.cacheControl ?? "private, no-cache",
    "last-modified": lastModifiedOf(stat, answeredAt).toUTCString(),
  });

  if (stat.contentLanguage !== undefined) headers.set("content-language", stat.contentLanguage);

  // A storage that hands over no `etag`, `adapter-fs`, gets none derived for it: a tag
  // built from size and time would claim a strength the layer cannot vouch for.
  if (stat.etag !== undefined) headers.set("etag", `"${stat.etag}"`);
  if (storage.capabilities.includes("rangeReads") && stat.contentEncoding === undefined) {
    headers.set("accept-ranges", "bytes");
  }

  return headers;
}

/**
 * The stored `Content-Disposition` where the caller names no download of its own and the
 * stored one is an attachment, which hands its writer no more than the name a download is
 * saved under; anything else would let it have the object rendered inline (ADR 0062).
 */
function contentDispositionOf(key: string, options: ServeObjectOptions, stat: ObjectStat): string {
  const stored = stat.contentDisposition;
  const callerNamesOne = options.filename !== undefined || options.disposition !== undefined;

  return !callerNamesOne && stored !== undefined && isAttachment(stored)
    ? stored
    : dispositionOf(key, options);
}
