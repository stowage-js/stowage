# The integration READMEs share the adapter sections

ADR 0018 gave every package README a fixed order of sections, install, example, runtimes, limits,
notes and the link into the spec, so that a reader who has seen one knows where to look in the
next, and let `@stowage/conformance` alone take a shape of its own, because it walks an adapter
author through a job. v0.5 adds four READMEs: `@stowage/http` (ADR 0046) and the integrations for
NestJS, Hono and Next.js (ADR 0047). They take the sections of the adapters.

A shape of their own, ordered by task (wire a storage, serve a download, accept an upload, presign
an upload), was weighed, because an integration is fitted into an application that already exists.
It was ruled out because the adapter sections already hold what the map collected without being
read differently. Limits is where a package keeps a promise weakly: a Next.js Proxy cutting a
chunked upload unnoticed, or a `HEAD` followed through `redirectToObject` failing at the provider.
Notes is what a caller writes themselves: a Fastify content type parser, `bodyParser: false`, a
test that replaces the storage. A task-ordered README would also have retold the layer's functions,
which the spec already states; the example shows them once, and the spec holds the rest.

Spec 16 has every `ts` block compile against the built declarations, and the shared `tsconfig` of
ADR 0008 cannot compile a NestJS controller as its reader writes one: `@Inject(token)` in a
constructor parameter property needs `experimentalDecorators` and is refused by
`erasableSyntaxOnly`. Writing the NestJS blocks without decorators would compile and teach a
NestJS reader something no NestJS application looks like, which is the false block ADR 0018 wrote
the rule against. Exempting framework code from the check was ruled out for the same reason. The
test therefore compiles each document with the compiler options of its reader's application. ADR
0047's rule against decorator syntax governs stowage's sources, not an application's code shown in
a README.

## Consequences

- Twelve READMEs point into the spec. `@stowage/http`, `@stowage/nestjs`, `@stowage/hono` and
  `@stowage/nextjs` carry install, example, runtimes, limits, notes and the link into the spec at
  the tag of their release, in that order, like the six packages of v0.4. An empty section says
  that it is empty; limits is empty for `@stowage/nestjs` and `@stowage/hono`.
- Runtimes of an integration names the peer range, the floor and the newest version CI ran at the
  release (ADR 0050), the integration's cells of the second table in spec section 2 with a link
  there, NestJS on Express and on Fastify apart, the Bun and Deno versions CI last ran green where
  the package runs there, and the bundle size measured without the framework, recorded and not
  promised (ADR 0003). Runtimes of `@stowage/http` adds that the Node bridge covers Node, Bun and
  Deno and not `workerd`.
- `@stowage/http`:
  - Example: a `fetch` handler answering `GET` and `HEAD` with `serveObject` and `PUT` with
    `acceptUpload` and its `maxSize`, the key named by the caller.
  - Limits: `redirectToObject` answers `HEAD` with `302`, and S3 and GCS refuse the followed `HEAD`
    with `403`; a caller who needs `HEAD` serves through `serveObject` (ADR 0048).
  - Notes: Express through the Node bridge; Fastify through `reply.hijack()` and the
    application-wide content type parser behind `removeAllContentTypeParsers()`, with `maxSize` taking over from `bodyLimit`, which that
    parser switches off (ADR 0049); Bun's `maxRequestBodySize` of 128 MiB; and that the body
    reaches the layer unread, since a validator or body parser in front of it ends in a `TypeError`
    (ADR 0051, ADR 0052).
- `@stowage/nestjs`:
  - Example: `StorageModule.forRoot({ provide, storage })` and a controller that injects with
    `@Inject(token)` and answers through `@Req()`, `@Res()`, `webRequestOf` and `sendResponse`.
  - Notes: on Fastify `removeAllContentTypeParsers()` and then
    `addContentTypeParser("*", (_req, _payload, done) => done(null))`, with `maxSize` taking over
    from `bodyLimit`; `NestFactory.create(AppModule, { bodyParser: false })`
    for uploads sent as JSON; `forRootAsync` with `inject`; a test replacing the storage with
    `overrideProvider(token).useValue(…)` (ADR 0051).
- `@stowage/hono`:
  - Example: `withStorage(name, storage)` typed through chaining, and a route serving through
    `serveObject`.
  - Notes: the same typing through an `Env` the application states; the factory `(c) => …` built
    from `c.env` on `workerd`; validators on upload routes reading the body; `bodyLimit()`,
    `etag()` and `compress()` on stowage's routes; Bun's 128 MiB body limit; a test building the app
    from `createApp(storages)` (ADR 0052).
- `@stowage/nextjs`:
  - Example: the application's storage module starting with `import "server-only"` and exporting
    `lazyStorage(…)`, and a route handler under a catch-all `[...key]` answering `GET` and `PUT`.
  - Limits: a Proxy matching an upload route cuts a chunked body at `proxyClientMaxBodySize`
    unnoticed, and the application leaves upload routes out of the `matcher` or raises the limit
    above `maxSize`. Whether a buffered body keeps its `Content-Length`, which `acceptUpload` would
    answer with `400`, is stated as the build of v0.5 measured it (ADR 0053).
  - Notes: the catch-all segments arriving decoded, so `a%2Fb` cannot be told apart from two
    segments; presigning through a route handler rather than a server action; `await connection()`
    before presigning in a Server Component; no `force-static`, `revalidate` or `'use cache'` around
    a `get`; a resolver built in the factory existing once per module graph; a test mocking the
    application's storage module (ADR 0053).
- Spec 16 fixes no order among the notes of these four; none of them leads the way the access token
  leads the notes of `adapter-azure-blob` and `adapter-gcs`.
- The README of `@stowage/conformance` gains a section "Test a server" after "Run the cases on
  `workerd`": how to write an `HttpConformanceTarget` and run the HTTP cases (ADR 0050), with
  `@stowage/hono` as the implementation to read, since it runs on all four runtimes.
- The root README's package table gains the four packages, and its count of packages released
  together becomes eleven. The two opening blocks and the flow 1 example stay as ADR 0018 drew
  them, a `put` of `request.body`, since a flow stays a call sequence against a storage (ADR 0054).
  One sentence after that example links `acceptUpload` of `@stowage/http` and the three integrations
  for a route with a size limit. No code block is added.
- The code-block test compiles each document with the compiler options its reader's application
  uses. The NestJS README compiles with `experimentalDecorators` and without `erasableSyntaxOnly`,
  against `@types/node` and `@types/express`; the frameworks are devDependencies of this repository
  already, because CI runs them.
- `CONTEXT.md` gains no term.
- This extends ADR 0018 and contradicts none of it. No released promise changes, so ADR 0017 is not
  touched.
