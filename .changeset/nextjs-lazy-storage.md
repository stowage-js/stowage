---
"@stowage/nextjs": minor
---

`@stowage/nextjs` joins the family as the integration for Next.js 16 on Node, with `next` `^16.3.8` as its peer (spec 13, ADR 0047, ADR 0053). `lazyStorage(factory)` returns a getter that runs `factory` on its first call and keeps the storage for the module instance it lives in, not on `globalThis`, so that `next build`, which evaluates the application's modules, constructs nothing until a request asks. One call holds one storage, with no name; two storages are two calls. The factory is synchronous, and one returning a `Promise` does not type-check. A factory that throws is not cached, so every call runs it again until it returns. The getter keeps the concrete type, so that `redirectToObject` and `presignUpload` of `@stowage/http` take an `S3Storage` without a cast. The package imports nothing from `next` and exports nothing else.
