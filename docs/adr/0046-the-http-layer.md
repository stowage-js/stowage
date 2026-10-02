# The HTTP layer is a package of functions over a named key, with a Node bridge built from its own types

v0.5 serves a storage over HTTP through NestJS, Hono and Next.js, and every other framework that
speaks web `Request` and `Response` reaches stowage through a framework-neutral HTTP layer that is
public and promised. That layer is `@stowage/http`: one function per thing it answers — serving an
object, accepting an upload body, handing out a presigned upload — each taking a storage, a key the
caller has already named and the web `Request`, and resolving with a web `Response`. A `StorageError`
becomes a `Response`; anything else, `AbortError` and programmer errors among it, is thrown on.

The alternative was a handler factory: `serveObjects(storage, { key, authorize })` returning a
finished route handler, with callbacks for the key, the authorization and the file name. Every
framework already has its own way to express a route parameter and an authorization check, and the
factory would rebuild each of them as a callback. The research on `research/nextjs-integration`
(commit `be1540b`) found nothing between a Next.js route handler and a neutral one but taking the
key out of `params`, and Hono's `c.req.param` and `c.req.raw` hand over the same two things. A
function over a named key needs no hook at all, so the question ADR 0042 settled for adapters does
not arise for the layer.

`@stowage/core` does nothing on its own (spec 4), so a subpath of it was ruled out, and a place
inside one of the three framework packages would have made SvelteKit depend on Hono for the neutral
layer. `@stowage/http` has no framework peer, so the reason a framework package might version on
its own — majors on a cadence stowage does not control — does not reach it, and it joins the `fixed`
group of ADR 0008 as the eighth package.

Express, with or without NestJS, and `node:http` cannot send a web `Response`; Fastify sends one but
answers `HEAD` on such a route with `500` (`research/nestjs-integration`, commit `15b6565`). The
same research measured a bridge from `Response` to `ServerResponse` at no measurable cost, and its
reader loop honoring `drain` cancels the source on `close` without `node:stream`. So the Node bridge
is part of `@stowage/http`, in its main entry, typed against interfaces the package declares for a
Node-style request and response rather than against `node:http`. It imports no `node:` module and
needs no `@types/node`, so the package keeps one set of runtimes, all four, and loads on `workerd`,
where the bridge has nothing to do. A subpath `@stowage/http/node` over `Readable.fromWeb` would
have given one package two sets of runtimes, which ADR 0008 answered with a package of its own for
`adapter-fs`; a package of its own for twenty lines was not worth that, and leaving the bridge out
would have sent Express callers to a third-party one.

What the bridge promises is the protocol of `node:http`'s request and response on Node, Bun and
Deno. Express and Fastify, through `reply.hijack()` and `reply.raw`, reach stowage through it the
way SvelteKit reaches it through `Request` and `Response`, and neither is named as a promised
framework. Naming them would have put two more frameworks under ADR 0002, each with its versions
and its cells, in a release that is meant to add three.

## Consequences

- The layer takes the portable `Storage` for everything in the parity core. For presigning it takes
  a structural type `@stowage/http` declares, naming the one method it calls with the options every
  adapter that declares `presignedUrls` shares — on `presignPut` `expiresIn`, `contentType` and
  `contentLength`, identical on all three. `S3Storage`, `AzureBlobStorage` and a `GcsStorage` built
  with a `signer` satisfy it, a `GcsStorage` without one fails to compile, and no concrete adapter
  type is named. The type does not move into `@stowage/core`, since presigning is no part of the
  parity core.
- The layer constructs no storage, reads no environment and holds no configuration: the storage
  arrives with every call. It keeps no registry or manager over several storages, by name or
  otherwise (ADR 0004), offers no hook into an adapter's requests and reaches nothing below a
  concrete type (ADR 0042). Routing, authorization, naming the key, CSRF and `multipart/form-data`
  stay with the caller. It buffers no body, detects no runtime at import time, and has no runtime
  dependency outside `@stowage/*`.
- Spec section 1 gains `@stowage/http` on Node, Bun, Deno and `workerd`, and section 11's seven
  packages become eight. Which `StorageError` becomes which status, and what `Range`, `HEAD` and
  the conditional headers do, is decided under "Serving a download through a framework route"
  (#306); what the upload and presign functions take under "Uploads through the server and the
  presign endpoint" (#307); how the layer and the bridge are tested under "When a framework
  integration counts as supported" (#308).
- The NestJS integration serves Express through the same bridge rather than one of its own.
- ADR 0048 adds a fourth answer, redirecting to a presigned download, with a structural type of its
  own for `presignGet`, separate from the one for presigned uploads.
