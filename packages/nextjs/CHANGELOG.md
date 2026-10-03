# @stowage/nextjs

## 0.5.0

### Minor Changes

- c1cc230: Each integration promises the major of its framework current at its release and the runtimes that framework promises: NestJS 12 on Node, Hono 4 on Node, Bun, Deno and `workerd`, Next.js 16 on Node. A later major is added in a minor release once CI covers it, and the peer range widens to hold both. A major its framework no longer supports leaves the way a Node line at end of life does, without a breaking release: Next.js's at the end of its Maintenance LTS, NestJS's and Hono's when the next major is released. Dropping a major its framework still supports, and raising a peer range's floor, are withdrawals (spec 1, 15, ADR 0047, ADR 0050).
- 4023443: `@stowage/nextjs` joins the family as the integration for Next.js 16 on Node, with `next` `^16.3.8` as its peer: the range starts at 16.3.8, the version CI ran at this release (spec 2, 13, ADR 0047, ADR 0053). `lazyStorage(factory)` returns a getter that runs `factory` on its first call and keeps the storage for the module instance it lives in, not on `globalThis`, so that `next build`, which evaluates the application's modules, constructs nothing until a request asks. One call holds one storage, with no name; two storages are two calls. The factory is synchronous, and one returning a `Promise` does not type-check. A factory that throws is not cached, so every call runs it again until it returns. The getter keeps the concrete type, so that `redirectToObject` and `presignUpload` of `@stowage/http` take an `S3Storage` without a cast. The package imports nothing from `next` and exports nothing else.

### Patch Changes

- @stowage/core@0.5.0
