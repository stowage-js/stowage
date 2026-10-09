# @stowage/nestjs

## 0.6.0

### Patch Changes

- Updated dependencies [bbe946a]
- Updated dependencies [966aa6c]
- Updated dependencies [cc305a2]
- Updated dependencies [bf62a4c]
- Updated dependencies [bf62a4c]
- Updated dependencies [5ddc2c3]
- Updated dependencies [4d46b94]
- Updated dependencies [4d46b94]
- Updated dependencies [8bcbfc9]
  - @stowage/core@0.6.0
  - @stowage/http@0.6.0

## 0.5.0

### Minor Changes

- c1cc230: Each integration promises the major of its framework current at its release and the runtimes that framework promises: NestJS 12 on Node, Hono 4 on Node, Bun, Deno and `workerd`, Next.js 16 on Node. A later major is added in a minor release once CI covers it, and the peer range widens to hold both. A major its framework no longer supports leaves the way a Node line at end of life does, without a breaking release: Next.js's at the end of its Maintenance LTS, NestJS's and Hono's when the next major is released. Dropping a major its framework still supports, and raising a peer range's floor, are withdrawals (spec 1, 15, ADR 0047, ADR 0050).
- 686728d: `@stowage/nestjs` joins the family as the integration for NestJS 12, with `@nestjs/common` `^12.1.2` as its peer: the range starts at 12.1.2, the version CI ran at this release (spec 2, 11, ADR 0047, ADR 0051). `StorageModule.forRoot({ provide, storage, global? })` registers one storage under the injection token `provide`, and `StorageModule.forRootAsync({ provide, useFactory, inject?, imports?, global? })` registers what its factory resolves with, the storage itself. `global` defaults to `true`, so that a feature module importing the registration again does not construct a second storage; `global: false` keeps the token to the importing module. There is no default token, no `InjectStorage`, no fake and no lifecycle hook: the application injects with `@Inject(token)`, and a test replaces the storage with `overrideProvider(token).useValue(…)`. `webRequestOf(req, res)` builds the web `Request` of the Node bridge from an Express request and response or from a Fastify request and reply, and `sendResponse(res, response)` writes a `Response` into an Express response or, after calling `reply.hijack()` itself, into a Fastify reply's `raw`. Both tell the platforms apart by shape and import neither `express` nor `fastify`, so a controller taking `@Req()` and `@Res()` reads the same on both. A body that a parser read before the call, NestJS's default JSON and URL-encoded parsers among them, makes `webRequestOf` throw the bridge's `TypeError`.

### Patch Changes

- Updated dependencies [dce8b6a]
  - @stowage/http@0.5.0
  - @stowage/core@0.5.0
