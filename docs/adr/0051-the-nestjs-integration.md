# The NestJS integration is one global module per storage under the caller's token, and answers through `@Res()`

`@stowage/nestjs` (ADR 0047) wires a storage into a NestJS 12 application and serves it through
`@stowage/http` (ADR 0046). The wiring is a dynamic module, `StorageModule`, with `forRoot` and
`forRootAsync`, because that is how a NestJS application expects to configure anything it injects,
and every NestJS storage module surveyed does it so (`research/nestjs-integration`, commit
`15b6565`). A custom provider `{ provide, useFactory, inject }` would have reached the same
container with no package at all, and a `provideStorage` helper would have left each application
to decide which module exports it; neither is the framework's own way of registering a configured
client.

Each registration holds one storage under an injection token the caller passes, and the module has
no default token and derives none from a name. Deriving tokens from a string, as `nestjs-s3` does
with `getStorageToken("avatars")`, turns the container into a lookup of storages by name, the
manager over several storages that spec 4.1 and ADR 0004 rule out, and a default token beside it
would have made one rule for a single storage and another for two. NestJS's injection is untyped
anyway, so a caller's token costs no type safety: the caller writes `Storage` or `S3Storage` on the
parameter. The rule the Hono and Next.js integrations follow is the same: one registration, one
storage, named by the caller.

NestJS 12 cannot send the web `Response` the layer answers with: on Express it serializes it to
`{}`, and Fastify answers `HEAD` on a route returning one with `500` (same research). A controller
therefore takes `@Res()` without `passthrough`, NestJS's documented way of handing the response to
the handler, and the package writes the `Response` through the Node bridge. An interceptor mapping
a returned `Response` was ruled out: without `@Res()` NestJS replies after it anyway, and the reply
collides with the one already sent on both platforms. Leaving the bridge to the controller would
have made every controller differ between Express and Fastify, where `reply.hijack()` and
`reply.raw` have to come first.

## Consequences

- `StorageModule.forRoot({ provide, storage, global? })` takes a constructed storage;
  `StorageModule.forRootAsync({ provide, useFactory, inject?, imports?, global? })` takes a factory
  that returns the storage itself, with no options object in between. `provide` is required and is
  any NestJS injection token. `provide` and `global` sit beside the factory, not in what it returns,
  because the exported token has to be known before the factory runs. There is no `useClass` and no
  `useExisting`.
- `global` defaults to `true`, as `TypeOrmModule.forRoot` and `MongooseModule.forRoot` do, because
  with the caller's token a feature module importing the module again would construct a second
  storage. `global: false` keeps the token to the importing module.
- The application injects with `@Inject(token)` in its own code; the package exports no
  `InjectStorage` and no token.
- A test replaces a storage with `overrideProvider(token).useValue(…)`; the package offers no fake
  and no `forTesting`.
- The module has no lifecycle hook. A storage holds nothing to release (spec 4.1), and an upload in
  flight follows `request.signal`, which the Node bridge aborts when the connection closes
  (ADR 0049).
- `webRequestOf(req, res)` builds the web `Request` from an Express request and response or from a
  Fastify request and reply through their `raw` fields. `sendResponse(res, response)` writes a
  `Response` into an Express response or, after `reply.hijack()`, into a Fastify reply's `raw`.
  Both go through the Node bridge, which answers
  `HEAD` without a body and cancels the source on disconnect. Both tell the platforms apart by
  their shape and import neither `express` nor `fastify`, so `@nestjs/common` stays the only peer,
  and a controller reads the same on both platforms:

  ```ts
  @Get("avatars/:id")
  async avatar(@Param("id") id: string, @Req() req: unknown, @Res() res: unknown) {
    await sendResponse(res, await serveObject(this.avatars, `avatars/${id}`, webRequestOf(req, res)));
  }
  ```

- The package exports no parameter decorator for the web `Request`; `webRequestOf(req, res)` is the one
  line it would save.
- On Fastify an upload body reaches `acceptUpload` only once the application registers a content
  type parser that leaves the payload unread (ADR 0049). The package does not register it, since a
  module import would then change how the whole application answers every unparsed content type,
  and exports no function for the one line. The README of `@stowage/nestjs` shows
  `addContentTypeParser("*", (_req, _payload, done) => done(null))` and says that `maxSize` takes
  over from Fastify's `bodyLimit`, which that parser switches off. Fastify's own parsers for
  `application/json` and `text/plain` take precedence over `*` and stay registered under
  `bodyParser: false`, so the README shows `removeAllContentTypeParsers()` in front of it; an
  upload of either type is otherwise read before the handler, which `webRequestOf` refuses.
- NestJS registers a JSON and a URL-encoded body parser by default, so an upload sent as
  `application/json` is read before the handler runs, or refused with `413` above the parser's
  limit. The Node bridge throws a `TypeError` when it builds a `Request` from a Node request whose
  body was already read, rather than handing `acceptUpload` an empty body to store. A body read
  before the call is the caller's programmer error and not a `StorageError`. The same holds for
  Express without NestJS behind a global `express.json()`. The README names
  `NestFactory.create(AppModule, { bodyParser: false })`.
- This adds to ADR 0046 the bridge's refusal of a body already read. Neither ADR is released, so
  no promise is narrowed and ADR 0017 is not touched.
- `CONTEXT.md` gains no term: an injection token is NestJS's word, not stowage's.
- Under "Write the v0.5 spec" (#309) `webRequestOf` takes the response as well, as
  `webRequestOf(req, res)`: the Node bridge aborts the signal of the `Request` it builds when the
  response closes early (ADR 0046), and a Fastify request leads to no reply. The controller above
  passes `res` as well. `sendResponse` calls `reply.hijack()` itself on Fastify, so the
  controller reads the same on both platforms.
