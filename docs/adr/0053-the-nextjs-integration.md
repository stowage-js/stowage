# The Next.js integration is one lazy getter per storage, and nothing else

`@stowage/nextjs` (ADR 0047) wires a storage into a Next.js 16 application and serves it through
`@stowage/http` (ADR 0046). Next.js has no container and no context object to hand a configured
client to a route; a route handler is a module export, `(request, { params }) => Response`, and
reaches a storage by importing it. Two facts constrain that import (`research/nextjs-integration`,
commit `be1540b`). `next build` evaluates the application's modules with the build's environment,
so a storage constructed at module top level is constructed during the build, where a constructor
refusing a missing bucket or credential (spec 4.3) fails it. And one process loads a module once
per module graph, measured three times for a module imported from `instrumentation.js`, from route
handlers and from a page.

The package therefore exports `lazyStorage(factory)`, which returns a getter that runs the factory
on its first call and keeps the storage for the module instance it lives in:

```ts
// lib/storage.ts
import "server-only";
import { lazyStorage } from "@stowage/nextjs";
import { s3Storage } from "@stowage/adapter-s3";

export const avatars = lazyStorage(() => s3Storage({ bucket: process.env.AVATARS_BUCKET!, … }));

// app/avatars/[...key]/route.ts
export async function GET(request: Request, { params }: { params: Promise<{ key: string[] }> }) {
  const { key } = await params;
  return serveObject(avatars(), `avatars/${key.join("/")}`, request);
}
```

The research proposed a storage on `globalThis`, as Prisma documents for its client. That is
ruled out. A key on `globalThis` has to be stable across module graphs, so it would be a name the
caller passes, and the name turns into a lookup of storages by name, the manager over several
storages that spec 4.1 and ADR 0004 rule out and ADR 0051 refused for NestJS. Two calls with one
name and different factories would share the first storage silently, and in `next dev` the value
outlives an edit of its factory. Prisma needs one client per process because it holds a connection
pool; a storage holds nothing between calls (spec 4.1), and every adapter resolves its credential
per request and caches nothing (spec 4.12). A second or third instance per process costs no I/O,
so what the build needs, constructing nothing until something asks, is all the getter does. A
resolver the caller builds inside the factory, such as a `google-auth-library` client, exists once
per module graph as well; the README says so.

A JavaScript `Proxy` that looks like a storage and constructs on first property access would have
saved the call parentheses. It was ruled out because reading `provider` would already construct,
and a debugger shows a proxy instead of the adapter.

The package adds nothing over that getter. ADR 0052 ruled out route factories, an error handler
and a re-export of `@stowage/http` for every integration. A helper taking the key out of `params`
was ruled out too: naming the key is the caller's (ADR 0046), and the one thing the helper could
refuse, a segment holding an encoded `/`, is a decision about the caller's keys.

## Consequences

- `lazyStorage<S extends Storage>(factory: () => S): () => S`. The getter keeps the concrete type,
  so `redirectToObject` and `presignUpload` compile on an `S3Storage` without a cast. One call holds
  one storage, and two storages are two calls, the rule ADR 0051 set. There is no name parameter.
- The factory is synchronous. Adapters construct synchronously, and whatever is asynchronous, a
  token or a secret, belongs in the credential resolver of spec 4.12. A factory returning a
  `Promise` does not type-check, since a `Promise` is no `Storage`.
- A factory that throws is not cached: every call runs it again and throws again, so a missing
  environment variable is a `500` from each request until it is set, not a storage that stays
  broken after the variable appears.
- `@stowage/nextjs` imports nothing from `next`. It keeps the peer dependency on `next` that ADR
  0047 requires even then, and with it the package is where the promise of Next.js 16 on Node
  (ADR 0050) lives. Folding the getter into a README section of `@stowage/http` was ruled out,
  because the layer would then promise a framework version without a peer range that npm checks.
- A test mocks the application's own storage module, such as `vi.mock("@/lib/storage")`, and calls
  the exported handler with `new Request(…)` and `{ params: Promise.resolve(…) }`. The package
  offers no override and no fake, as `@stowage/nestjs` and `@stowage/hono` do not.
- The package offers nothing for presigning outside a route handler; the README shows both:
  - A Server Component embedding a presigned `GET` calls `await connection()` first. Under
    `cacheComponents` the clock read of signing fails the build without it, and under the default
    model a page prerendered at build time would carry a URL signed then that has since expired.
  - A server action cannot return the `Response` of `presignUpload`, so it would call `presignPut`
    itself and skip the checks of ADR 0049, and Next.js runs one action at a time per client, so
    ten files are ten round trips in sequence. The README presigns through a route handler and
    names both.
- A Proxy matching an upload route buffers the body and cuts it at `proxyClientMaxBodySize`, 10 MB
  by default, and the package can neither detect nor switch it off. The README tells the
  application to leave upload routes out of the Proxy's `matcher` or to raise the limit above
  `maxSize`. Only a chunked body is cut undetectably, provided Next.js keeps the `Content-Length`
  of a body it buffered, in which case `acceptUpload` answers `400` (ADR 0049). That is not
  measured; the README states it only once the build of v0.5 has measured it.
- Next.js patches the global `fetch` the adapters call, caches provider responses while
  prerendering and on routes with `force-static` or `revalidate`, and reads their bodies whole. No
  adapter states `cache: 'no-store'`, since that would change every adapter on every runtime for
  one framework, and `workerd` has refused the `cache` option before. A serving route stays dynamic
  because `serveObject` reads the request's method and headers. The README warns against
  `force-static`, `revalidate` and `'use cache'` around a `get`.
- Without `server-only` (ADR 0047), a Client Component importing the application's storage module
  bundles adapter code for the browser, where the factory reads empty environment variables. The
  README makes `import "server-only"` the first line of that module; Next.js aliases it, so the
  application installs nothing.
- The README shows a catch-all segment `[...key]` and that Next.js hands over its segments
  decoded, so a segment `a%2Fb` arrives as `a/b` and cannot be told apart from two segments after
  `join("/")`.
- No ADR this builds on is released, so no promise is narrowed and ADR 0017 is not touched.
- `CONTEXT.md` gains no term.
