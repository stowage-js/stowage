# The Hono integration is one middleware per storage under the caller's name, and nothing else

`@stowage/hono` (ADR 0047) wires a storage into a Hono 4 application and serves it through
`@stowage/http` (ADR 0046). Hono's own way of handing a configured client to a route is a
middleware that sets it on `c.var` (`research/hono-integration`, commit `b9feab7`), so the package
exports one: `withStorage(name, storage)`. It follows the rule ADR 0051 set for NestJS: one call
holds one storage, under a name the caller passes, with no default name. Two storages are two
calls. The name `storage(…)`, in the style of Hono's `cors()` and `etag()`, was ruled out because
it shadows the variable every application already calls `storage`, and reads like
`contextStorage()` from `hono/context-storage`, which is about `AsyncLocalStorage`.

`storage` is either a constructed storage or a function `(c) => Storage | Promise<Storage>`, called
on every request. On `workerd` the credential arrives with the request in `c.env`, so the
function form is needed; on Node, Bun and Deno a storage built at module scope is the natural one.
No adapter holds anything tied to a request, such as a cached token or an open connection, so
building one per request costs no I/O. Building it only on the first request and caching it would
need a key to cache it under, and the function's input differs on every request. A `Promise` is
allowed because some bindings deliver their value only asynchronously, such as Cloudflare's
Secrets Store with `await env.SECRET.get()`.

The package adds nothing over that middleware. A route is one line:

```ts
app.get("/avatars/:id", (c) =>
  serveObject(c.var.avatars, `avatars/${c.req.param("id")}`, c.req.raw),
);
```

Hono routes `HEAD` to the `GET` handler and discards the body unread, but `c.req.raw.method` stays
`"HEAD"`, and the layer answers it from `stat` with no body (ADR 0048). Route factories would
rebuild Hono's routing as callbacks, which ADR 0046 ruled out for the layer itself. An `onError`
handler mapping a thrown `StorageError` to a status was ruled out as well. The layer throws no
`StorageError`, so such a handler would see only errors from the application's own calls on the
storage. ADR 0048's table is not right for those: a `NotFound` from a `delete` is not a `404` for
the client.

## Consequences

- `withStorage<K extends string, S extends Storage>(name: K, storage: S | ((c) => S | Promise<S>))`
  returns a `MiddlewareHandler<{ Variables: { [k in K]: S } }>`. `c.var.avatars` keeps its
  concrete type, so `redirectToObject` and `presignUpload` compile on an `S3Storage` without a
  cast. A function's `Bindings` come from its annotated parameter,
  `(c: Context<{ Bindings: Env }>) => …`.
- A middleware's `Variables` reach a handler's type only through chaining or an `Env` the
  application states (`research/hono-integration`); the README shows both. The package does not
  augment `ContextVariableMap`. That interface applies to every route, including routes the
  middleware does not run on, and the name is only known to the caller.
- No integration re-exports `@stowage/http`: the application installs it beside `@stowage/hono`,
  and every function of the layer has one import path. The same holds for `@stowage/nextjs` and
  `@stowage/nestjs`. Neither `@stowage/hono` nor `@stowage/nextjs` exports an error handler or a
  route factory.
- A test builds the application from a function, such as `createApp({ avatars })`, and passes it a
  storage from `adapter-memory`, or passes a test `env` to `app.request(path, init, env)` for the
  function form. The package offers no override and no fake.
- The package detects no runtime and treats none apart. `@hono/node-server` replaces the global
  `Request` and `Response` with subclasses, which the layer builds its answers with. It recognises
  its own answers by the object itself, not by `instanceof`. Whether `workerd` cancels the stream
  of `get` on a disconnect is the disconnect test's to settle per cell (ADR 0050).
- Hono's middleware that buffers or rewrites a body is the README's, since the package can neither
  detect nor switch it off:
  - `bodyLimit()` on an upload route reads every chunked body into memory, and `maxSize` replaces
    it.
  - `etag()` on a serving route repeats what the layer does where the storage hands over an
    `etag`. On `adapter-fs`, which hands over none, it reads the whole object through
    `res.clone()` and tags a `206` with the hash of its part.
  - `compress()` leaves a `206`, a `HEAD` and a `Cache-Control: no-transform` alone, and
    compresses a `200` as a stream, weakening its `ETag`. It is safe on a serving route.
  - `Bun.serve` refuses a body above 128 MiB (`maxRequestBodySize`) before Hono runs. This is
    a second limit beside `maxSize`.
- `c.req.json()`, `c.req.parseBody()` or a validator reading the body before `acceptUpload`
  consume `c.req.raw`. `acceptUpload` throws a `TypeError` before `put` starts when
  `request.bodyUsed` is `true`, rather than storing an empty or partial body. The read body is
  the caller's programmer error and not a `StorageError`. This adds to ADR 0049 and extends the
  Node bridge's refusal of a body already read (ADR 0051) to every web `Request`. The README of
  `@stowage/hono` names validators on upload routes.
- Neither ADR 0049 nor ADR 0051 is released, so no promise is narrowed and ADR 0017 is not
  touched.
- `CONTEXT.md` gains no term.
