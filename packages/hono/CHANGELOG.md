# @stowage/hono

## 0.6.0

### Patch Changes

- Updated dependencies [bbe946a]
- Updated dependencies [966aa6c]
- Updated dependencies [cc305a2]
  - @stowage/core@0.6.0

## 0.5.0

### Minor Changes

- 4cb3a05: `@stowage/hono` joins the family as the integration for Hono 4, with `hono` `^4.13.12` as its peer: the range starts at 4.13.12, the version CI ran at this release, on `@hono/node-server` 2.1.3 (spec 2, 12, ADR 0047, ADR 0052). `withStorage(name, storage)` is a middleware that sets one storage on `c.var[name]` and keeps its concrete type, so that `redirectToObject` and `presignUpload` of `@stowage/http` take `c.var[name]` of an `S3Storage` without a cast. `storage` is a constructed storage, set as it is, or a function called on every request without caching, which may resolve asynchronously and takes its `Bindings` from its annotated parameter, the form for `workerd`, where the credential arrives in `c.env`. `ContextVariableMap` is not augmented. A route answers through `@stowage/http` with `c.req.raw`, whose `method` stays `"HEAD"` where Hono routes a `HEAD` to the `GET` handler.
- c1cc230: Each integration promises the major of its framework current at its release and the runtimes that framework promises: NestJS 12 on Node, Hono 4 on Node, Bun, Deno and `workerd`, Next.js 16 on Node. A later major is added in a minor release once CI covers it, and the peer range widens to hold both. A major its framework no longer supports leaves the way a Node line at end of life does, without a breaking release: Next.js's at the end of its Maintenance LTS, NestJS's and Hono's when the next major is released. Dropping a major its framework still supports, and raising a peer range's floor, are withdrawals (spec 1, 15, ADR 0047, ADR 0050).

### Patch Changes

- @stowage/core@0.5.0
