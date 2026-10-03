---
"@stowage/hono": minor
---

`@stowage/hono` joins the family as the integration for Hono 4, with `hono` `^4.13.12` as its peer: the range starts at 4.13.12, the version CI ran at this release, on `@hono/node-server` 2.1.3 (spec 2, 12, ADR 0047, ADR 0052). `withStorage(name, storage)` is a middleware that sets one storage on `c.var[name]` and keeps its concrete type, so that `redirectToObject` and `presignUpload` of `@stowage/http` take `c.var[name]` of an `S3Storage` without a cast. `storage` is a constructed storage, set as it is, or a function called on every request without caching, which may resolve asynchronously and takes its `Bindings` from its annotated parameter, the form for `workerd`, where the credential arrives in `c.env`. `ContextVariableMap` is not augmented. A route answers through `@stowage/http` with `c.req.raw`, whose `method` stays `"HEAD"` where Hono routes a `HEAD` to the `GET` handler.
