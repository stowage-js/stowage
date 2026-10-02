import type { S3Storage } from "../../../packages/adapter-s3/src/index.ts";
import type { HttpConformanceTarget } from "../../../packages/conformance/src/http-target.ts";
import {
  acceptUpload,
  presignUpload,
  redirectToObject,
  serveObject,
} from "../../../packages/http/src/index.ts";

/**
 * What a repository test may configure beyond spec 14.8's routes: the flat-memory test
 * uploads far more than the suite's 1 MiB.
 */
export interface RouteOptions {
  readonly maxSize: number;
}

/** Spec 14.8's `maxSize` of the `upload` and the `presign` route. */
const suiteMaxSize = 1048576;

export const suiteRoutes: RouteOptions = { maxSize: suiteMaxSize };

/** The answers of spec 14.8, each the first segment of its route. */
const routePattern = /^\/(serve|redirect|upload|presign)\/([^/?]*)$/u;

/**
 * The URLs of the routes at `origin`. The key travels as one encoded path segment, so that
 * a key holding `/`, `?` or `%` arrives as it was sent.
 */
export function routeUrls(origin: string): HttpConformanceTarget["url"] {
  return (route, key) => new URL(`/${route}/${encodeURIComponent(key)}`, origin);
}

/**
 * Spec 14.8's routes as one `fetch` handler, which `Bun.serve`, `Deno.serve`, a worker's
 * `fetch` and the Node bridge each hand their requests to. It imports no `node:` module,
 * since the `workerd` cell bundles it at the flags of spec 1. Spec 14.8 fixes what each
 * route is configured with, `routes` aside. Any other path answers `404`.
 */
export function routesOf(
  storage: S3Storage,
  routes: RouteOptions = suiteRoutes,
): (request: Request) => Promise<Response> {
  return async (request) => {
    const [, route, encodedKey = ""] = routePattern.exec(new URL(request.url).pathname) ?? [];
    let key: string;

    try {
      key = decodeURIComponent(encodedKey);
    } catch {
      return new Response(null, { status: 404 });
    }

    if (route === "serve") return await serveObject(storage, key, request);
    if (route === "redirect") {
      return await redirectToObject(storage, key, request, { expiresIn: 60 });
    }
    if (route === "upload") {
      return await acceptUpload(storage, key, request, { maxSize: routes.maxSize });
    }
    if (route === "presign") return await presign(storage, key, request);

    return new Response(null, { status: 404 });
  };
}

/**
 * Spec 14.8's `presign` route, which is the target's and not a protocol of the layer: it
 * answers any method but `POST` itself, and hands both values of the JSON body on as they
 * arrived, so that the layer's own checks of spec 10.6 are what a case meets.
 */
async function presign(storage: S3Storage, key: string, request: Request): Promise<Response> {
  if (request.method !== "POST") {
    return new Response(null, { status: 405, headers: { allow: "POST" } });
  }

  let values: unknown;

  try {
    values = JSON.parse(await request.text());
  } catch {
    return new Response(null, { status: 400 });
  }

  if (typeof values !== "object" || values === null || Array.isArray(values)) {
    return new Response(null, { status: 400 });
  }

  // oxlint-disable-next-line no-unsafe-type-assertion -- unchecked on purpose, as said above
  const { contentType, contentLength } = values as { contentType: string; contentLength: number };

  return await presignUpload(storage, key, {
    expiresIn: 60,
    maxSize: suiteMaxSize,
    contentType,
    contentLength,
  });
}
