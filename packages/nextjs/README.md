# @stowage/nextjs

The Next.js integration of stowage: `lazyStorage(factory)` builds a storage on its first use, so
that `next build` constructs none, and a route handler answers through `@stowage/http`.

## Install

In a Next.js 16 application, install the integration, the HTTP layer and an adapter:

```sh
npm install @stowage/nextjs @stowage/http @stowage/adapter-s3
```

## Example

The application's storage module starts with `import "server-only"`, so that a Client Component
importing it fails the build rather than bundle adapter code for the browser. Next.js aliases
`server-only`, so the application installs nothing for it.

```ts
// lib/storage.ts
import "server-only";

import { fromEnv, s3Storage } from "@stowage/adapter-s3";
import { lazyStorage } from "@stowage/nextjs";

export const files = lazyStorage(() =>
  s3Storage({
    bucket: process.env.FILES_BUCKET ?? "",
    region: "eu-north-1",
    credentials: fromEnv,
  }),
);
```

`next build` evaluates this module without the server's environment. The getter builds the storage
on its first call, from the first request on. A factory that throws is not cached: until
`FILES_BUCKET` is set, every request runs it again and answers `500`.

A route handler under a catch-all segment `[...key]` serves the objects and accepts uploads of up
to 100 MiB:

```ts
// app/files/[...key]/route.ts
import { acceptUpload, serveObject } from "@stowage/http";

import { files } from "@/lib/storage";

interface Segments {
  params: Promise<{ key: string[] }>;
}

const keyOf = async ({ params }: Segments): Promise<string> =>
  `files/${(await params).key.join("/")}`;

export async function GET(request: Request, segments: Segments): Promise<Response> {
  return await serveObject(files(), await keyOf(segments), request);
}

export async function PUT(request: Request, segments: Segments): Promise<Response> {
  return await acceptUpload(files(), await keyOf(segments), request, {
    maxSize: 100 * 1024 * 1024,
  });
}
```

Next.js routes a `HEAD` to `GET` with the request's method kept, which `serveObject` answers from
`stat` without a body. The getter keeps the concrete type, so `redirectToObject` and
`presignUpload` take `files()` without a cast. Two storages are two calls of `lazyStorage`
([spec 13](https://github.com/stowage-js/stowage/blob/@stowage/nextjs@0.5.0/docs/spec.md#13-stowagenextjs)).

## Runtimes

Node 24 and later, with the peer `next` `^16.3.8`. Its floor is 16.3.8, and at this release
CI ran 16.3.8 as the newest release of Next.js 16, each through `next build` and `next start` on
Node 24 and Node 26.

|                   | Node | Bun | Deno | `workerd` |
| ----------------- | ---- | --- | ---- | --------- |
| `@stowage/nextjs` | yes  | no  | no   | no        |

These are the package's cells in the
[runtime matrix](https://github.com/stowage-js/stowage/blob/@stowage/nextjs@0.5.0/docs/spec.md#2-runtime-matrix).
Bun and Deno are not promised, as Next.js promises neither.

The bundle measures 0.1 kB minified and gzipped, without Next.js.

## Limits

- A Proxy whose `matcher` matches an upload route buffers the body and cuts it at
  `proxyClientMaxBodySize`, 10 MB by default. A chunked body arrives cut and unmarked, and
  `acceptUpload` stores it as complete. A body with a `Content-Length` keeps that header while it
  arrives cut, and `acceptUpload` answers it `400`; Next.js 16.3.8 did so when measured for this
  release. An application leaves its upload routes out of the `matcher`, or raises
  `experimental.proxyClientMaxBodySize` above `maxSize`
  ([spec 13](https://github.com/stowage-js/stowage/blob/@stowage/nextjs@0.5.0/docs/spec.md#13-stowagenextjs)).

## Notes

### Segments arrive decoded

Next.js hands over the segments of `[...key]` decoded. A segment `a%2Fb` arrives as `a/b`, and after
`join("/")` it cannot be told apart from the two segments `a` and `b`. Naming the key stays with
the application, which refuses such a segment where its keys must not hold one.

### Presign through a route handler

A server action cannot return the `Response` of `presignUpload`, so it would call `presignPut`
itself and skip the checks of `contentLength` and `contentType`. Next.js also runs one server
action at a time per client, so ten files would be ten round trips in sequence. A route handler
presigns instead:

```ts
// app/uploads/[...key]/route.ts
import { presignUpload } from "@stowage/http";

import { files } from "@/lib/storage";

export async function POST(
  request: Request,
  { params }: { params: Promise<{ key: string[] }> },
): Promise<Response> {
  const { contentType, contentLength } = (await request.json()) as {
    contentType: string;
    contentLength: number;
  };

  return await presignUpload(files(), `files/${(await params).key.join("/")}`, {
    expiresIn: 300,
    maxSize: 100 * 1024 * 1024,
    contentType,
    contentLength,
  });
}
```

### Presign in a Server Component after `connection()`

A Server Component that embeds a presigned URL calls `await connection()` first. Without it, a page
prerendered by `next build` carries a URL signed at build time, which has expired by the time it is
served, and under `cacheComponents` the clock read of signing fails the build:

```ts
// lib/download-url.ts
import { connection } from "next/server";

import { files } from "@/lib/storage";

export async function downloadUrl(name: string): Promise<string> {
  await connection();

  return await files().presignGet(`files/${name}`, { expiresIn: 300 });
}
```

### Keep `get` out of Next.js's cache

Next.js patches the global `fetch` the adapters call. Under `export const dynamic = "force-static"`,
`revalidate` or `'use cache'`, it caches the provider's answers and reads their bodies whole, and
no adapter opts out of that. A route or a function that calls `get` stays clear of all three. A
route that serves through `serveObject` stays dynamic on its own, since it reads the request.

### One storage per module graph

The getter keeps the storage for the module instance it lives in, and a Next.js server loads a
module once per module graph, so one process may hold a few storages. That costs no I/O, since a
storage holds nothing between calls. A credential resolver the factory builds, such as a
`google-auth-library` client, exists once per module graph as well.

### Replace the storage in tests

The package offers no override and no fake. A test mocks the application's storage module and
calls the route handler itself:

```ts
import { memoryStorage } from "@stowage/adapter-memory";
import { expect, test, vi } from "vitest";

import { GET } from "@/app/files/[...key]/route";

vi.mock("@/lib/storage", () => {
  const storage = memoryStorage();

  return { files: () => storage };
});

test("answers 404 for a missing file", async () => {
  const response = await GET(new Request("http://localhost/files/missing.txt"), {
    params: Promise.resolve({ key: ["missing.txt"] }),
  });

  expect(response.status).toBe(404);
});
```

## Specification

[`docs/spec.md` at `@stowage/nextjs@0.5.0`](https://github.com/stowage-js/stowage/blob/@stowage/nextjs@0.5.0/docs/spec.md#13-stowagenextjs)
is the contract: a caller may rely on what it states and on nothing else this package happens to
export. The [terms it uses](https://github.com/stowage-js/stowage/blob/@stowage/nextjs@0.5.0/CONTEXT.md)
and the [decisions behind it](https://github.com/stowage-js/stowage/tree/@stowage/nextjs@0.5.0/docs/adr)
are at the same tag.

## License

MIT
