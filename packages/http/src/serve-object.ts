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
import { type Preconditions, preconditionsOf, rangeHolds, verdictOf } from "./preconditions.ts";
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
 * `Range` is ignored. The preconditions of RFC 9110 13.2.2 answer `304` or `412` where one
 * fails, and `If-Range` sends the whole object for anything but the strong `ETag`.
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
      const verdict = preconditions === undefined ? "perform" : verdictOf(preconditions, stat);

      return verdict === "perform"
        ? new Response(null, { status: 200, headers: objectHeaders(serving, stat) })
        : refusal(serving, verdict, stat);
    }

    const requested = storage.capabilities.includes("rangeReads")
      ? requestedRangeOf(request.headers.get("range"))
      : undefined;
    // RFC 9110 13.1.5: `If-Range` counts only beside a range the layer would serve.
    const ifRange = requested === undefined ? null : request.headers.get("if-range");

    if (preconditions === undefined && ifRange === null) {
      if (requested === undefined) return await serveWhole(serving);
      if (!("suffixLength" in requested)) return await serveRange(serving, requested);
    }

    const stat = await storage.stat(key, { signal: serving.signal });
    const conditions: Conditions = { preconditions, requested, ifRange };

    return await servePlanned(serving, { stat, decide: (each) => planOf(conditions, each) });
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

/** What of a `GET` decides its answer from a `stat` (ADR 0048). */
interface Conditions {
  readonly preconditions: Preconditions | undefined;
  readonly requested: RequestedRange | undefined;
  readonly ifRange: string | null;
}

/** The answer a `GET` gets from one `stat`, the range a `206` sends with it. */
type Plan =
  | { readonly status: 304 | 412 | 416 | 200 }
  | { readonly status: 206; readonly range: ByteRange };

/**
 * RFC 9110 13.2.2, the range last. Only a suffix needs the size; RFC 9110 14.1.2 makes an
 * empty suffix unsatisfiable, and any other suffix of an empty object the whole of it,
 * which no `Content-Range` can name.
 */
function planOf({ preconditions, requested, ifRange }: Conditions, stat: ObjectStat): Plan {
  const verdict = preconditions === undefined ? "perform" : verdictOf(preconditions, stat);

  if (verdict !== "perform") return { status: verdict };
  if (requested === undefined || !rangeHolds(ifRange, stat)) return { status: 200 };
  if (!("suffixLength" in requested)) return { status: 206, range: requested };
  if (requested.suffixLength === 0) return { status: 416 };
  if (stat.size === 0) return { status: 200 };

  return { status: 206, range: suffixOf(requested.suffixLength, stat.size) };
}

/**
 * A plan made from the `stat` before `get`, to be made again from the `stat` of `get`,
 * which describes the bytes sent (ADR 0048).
 */
interface Planned {
  readonly stat: ObjectStat;
  readonly decide: (stat: ObjectStat) => Plan;
}

async function servePlanned(serving: ServeRequest, planned: Planned): Promise<Response> {
  const plan = planned.decide(planned.stat);

  switch (plan.status) {
    case 200:
      return await serveWhole(serving, planned);
    case 206:
      return await serveRange(serving, plan.range, planned);
    case 416:
      return rangeNotSatisfiable(planned.stat.size);
    default:
      return refusal(serving, plan.status, planned.stat);
  }
}

/**
 * The plan the `stat` of `get` makes, `undefined` where it describes the object planned
 * on. Spec 10.3: the `etag`s tell a changed object, and without them `size` and
 * `lastModified`.
 */
function replanned(planned: Planned | undefined, handed: ObjectStat): Plan | undefined {
  if (planned === undefined) return undefined;

  const { stat: seen } = planned;
  const changed =
    seen.etag !== undefined && handed.etag !== undefined
      ? seen.etag !== handed.etag
      : seen.size !== handed.size || seen.lastModified.getTime() !== handed.lastModified.getTime();

  return changed ? planned.decide(handed) : undefined;
}

/** The answer of a failed precondition: `304` with the headers of a `200`, or `412`. */
function refusal(serving: ServeRequest, status: 304 | 412, stat: ObjectStat): Response {
  return status === 304
    ? new Response(null, { status, headers: objectHeaders(serving, stat) })
    : new Response(null, { status });
}

async function serveWhole(serving: ServeRequest, planned?: Planned): Promise<Response> {
  const object = await serving.storage.get(serving.key, { signal: serving.signal });
  const plan = replanned(planned, object.stat);

  // Any other plan still takes the whole object, which RFC 9110 14.2 lets a server send
  // for a range it would otherwise serve.
  if (plan?.status === 304 || plan?.status === 412) {
    await discard(object);

    return refusal(serving, plan.status, object.stat);
  }

  // No `Content-Length`: an object another tool stored with a content coding may arrive
  // decoded and longer than `size`, and Node and Deno would cut such a body to `size`
  // and end the response as complete.
  return new Response(object.stream(), {
    status: 200,
    headers: objectHeaders(serving, object.stat),
  });
}

/** A `206` whose `Content-Range` follows the `stat` of `get`, which describes the bytes sent. */
async function serveRange(
  serving: ServeRequest,
  range: ByteRange,
  planned?: Planned,
): Promise<Response> {
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
    if (thrown.code === "ProviderError" && !thrown.retryable) {
      return await serveWhole(serving, planned);
    }

    throw thrown;
  }

  const plan = replanned(planned, object.stat);

  if (planned !== undefined && plan !== undefined && !sendsRange(plan, range)) {
    await discard(object);

    // Spec 10.3: at most one more `get`, and a whole one, decided again by its own `stat`.
    return plan.status === 304 || plan.status === 412
      ? refusal(serving, plan.status, object.stat)
      : await serveWhole(serving, { ...planned, stat: object.stat });
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
