# @stowage/hono

Part of [stowage](https://github.com/stowage-js/stowage#readme): one typed API for object storage
across S3, R2, Azure Blob, GCS and local disk.

The Hono integration of stowage: `withStorage(name, storage)` sets a storage on `c.var[name]`,
and a route answers through `@stowage/http` with `c.req.raw`.

## Install

In a Hono 4 application, install the integration, the HTTP layer and an adapter:

```sh
npm install @stowage/hono @stowage/http @stowage/adapter-s3
```

## Example

The middleware sets the storage under the name the application passes, and chaining carries its
type to the routes after it. `c.var.avatars` stays an `S3Storage`, so `redirectToObject`, which
needs `presignGet`, takes it without a cast:

```ts
import { fromEnv, s3Storage } from "@stowage/adapter-s3";
import { withStorage } from "@stowage/hono";
import { redirectToObject, serveObject } from "@stowage/http";
import { Hono } from "hono";

const avatars = s3Storage({ bucket: "my-app-avatars", region: "eu-north-1", credentials: fromEnv });

const app = new Hono()
  .use(withStorage("avatars", avatars))
  .get(
    "/avatars/:id",
    async (c) => await serveObject(c.var.avatars, `avatars/${c.req.param("id")}`, c.req.raw),
  )
  .get(
    "/avatars/:id/download",
    async (c) =>
      await redirectToObject(c.var.avatars, `avatars/${c.req.param("id")}`, c.req.raw, {
        expiresIn: 300,
      }),
  );

export default app;
```

Hono routes a `HEAD` to the `GET` handler, and `c.req.raw.method` stays `"HEAD"`, which
`serveObject` answers from `stat` without a body. Bun, Deno and `workerd` serve `app` as it is
exported; on Node, `serve(app)` of `@hono/node-server` does. Two storages are two calls of
`withStorage` under two names
([spec 12](https://github.com/stowage-js/stowage/blob/@stowage/hono@0.6.0/docs/spec.md#12-stowagehono)).

## Runtimes

Node 24 and later, Bun, Deno and `workerd` at the compatibility date `2026-09-01` without Node
APIs, with the peer `hono` `^4.13.12`. Its floor is 4.13.12, on `@hono/node-server` 2.1.3, and at
this release CI ran 4.13.13 as the newest release of Hono 4. CI last ran green on Bun 1.4.2 and Deno 2.9.6.

|                 | Node | Bun | Deno | `workerd` |
| --------------- | ---- | --- | ---- | --------- |
| `@stowage/hono` | yes  | yes | yes  | yes       |

These are the package's cells in the
[runtime matrix](https://github.com/stowage-js/stowage/blob/@stowage/hono@0.6.0/docs/spec.md#2-runtime-matrix).

The bundle measures 0.1 kB minified and gzipped, without Hono.

## Limits

This section is empty.

## Notes

### Type the variables through an `Env`

An application that adds its routes one statement at a time, rather than chaining them, states the
variable in the `Env` it gives `Hono`:

```ts
import { fromEnv, type S3Storage, s3Storage } from "@stowage/adapter-s3";
import { withStorage } from "@stowage/hono";
import { serveObject } from "@stowage/http";
import { Hono } from "hono";

type AppEnv = { Variables: { avatars: S3Storage } };

const app = new Hono<AppEnv>();

app.use(
  withStorage(
    "avatars",
    s3Storage({ bucket: "my-app-avatars", region: "eu-north-1", credentials: fromEnv }),
  ),
);

app.get(
  "/avatars/:id",
  async (c) => await serveObject(c.var.avatars, `avatars/${c.req.param("id")}`, c.req.raw),
);
```

### Build the storage from `c.env` on `workerd`

A worker receives its credential with the request, in `c.env`. `withStorage` then takes a function,
called on every request and never cached, whose `Bindings` come from its annotated parameter. A
storage holds nothing between calls, so building one per request costs no I/O:

```ts
import { s3Storage } from "@stowage/adapter-s3";
import { withStorage } from "@stowage/hono";
import { serveObject } from "@stowage/http";
import { type Context, Hono } from "hono";

type Bindings = { R2_ACCOUNT_ID: string; R2_ACCESS_KEY_ID: string; R2_SECRET_ACCESS_KEY: string };

const app = new Hono<{ Bindings: Bindings }>()
  .use(
    withStorage("avatars", (c: Context<{ Bindings: Bindings }>) =>
      s3Storage({
        bucket: "my-app-avatars",
        region: "auto",
        endpoint: `https://${c.env.R2_ACCOUNT_ID}.r2.cloudflarestorage.com`,
        credentials: () => ({
          accessKeyId: c.env.R2_ACCESS_KEY_ID,
          secretAccessKey: c.env.R2_SECRET_ACCESS_KEY,
        }),
      }),
    ),
  )
  .get(
    "/avatars/:id",
    async (c) => await serveObject(c.var.avatars, `avatars/${c.req.param("id")}`, c.req.raw),
  );

export default app;
```

The function may return a `Promise`, for a binding that hands over its value asynchronously.

### Leave the body to `acceptUpload`

A validator, `c.req.json()` or `c.req.parseBody()` on an upload route reads the body before
`acceptUpload` does, which then rejects with a `TypeError` before `put` starts. An upload route
checks the key and the headers, and leaves the body to the layer.

### Hono's middleware on stowage's routes

- `bodyLimit()` on an upload route reads a body without `Content-Length` into memory before the
  handler runs. `maxSize` limits the upload while it streams and takes its place.
- `etag()` on a serving route repeats what the layer does where the storage hands over an `etag`.
  On `@stowage/adapter-fs`, which hands over none, it reads the whole object through `res.clone()`
  and tags a `206` with the hash of its part, so it stays off stowage's routes.
- `compress()` leaves a `206`, a `HEAD` and a `Cache-Control: no-transform` alone, and compresses a
  `200` as a stream, weakening its `ETag`. It is safe on a serving route.
- `Bun.serve` refuses a body above 128 MiB, its default `maxRequestBodySize`, before Hono runs: a
  second limit beside `maxSize`.

### Replace the storage in tests

The package offers no override and no fake. A test builds the application from a function that
takes its storages, and passes it a storage from `@stowage/adapter-memory`:

```ts
import { memoryStorage } from "@stowage/adapter-memory";
import type { Storage } from "@stowage/core";
import { withStorage } from "@stowage/hono";
import { serveObject } from "@stowage/http";
import { Hono } from "hono";
import { expect, test } from "vitest";

function createApp(storages: { avatars: Storage }) {
  return new Hono()
    .use(withStorage("avatars", storages.avatars))
    .get(
      "/avatars/:id",
      async (c) => await serveObject(c.var.avatars, `avatars/${c.req.param("id")}`, c.req.raw),
    );
}

test("serves a stored avatar", async () => {
  const avatars = memoryStorage();

  await avatars.put("avatars/alice", "PNG", { contentType: "image/png" });

  const response = await createApp({ avatars }).request("/avatars/alice");

  expect(response.status).toBe(200);
  expect(await response.text()).toBe("PNG");
});
```

The application itself calls `createApp` with the storages it constructs. For the function form,
`app.request(path, init, env)` hands the test's `env` to the function.

## Specification

[`docs/spec.md` at `@stowage/hono@0.6.0`](https://github.com/stowage-js/stowage/blob/@stowage/hono@0.6.0/docs/spec.md#12-stowagehono)
is the contract: a caller may rely on what it states and on nothing else this package happens to
export. The [terms it uses](https://github.com/stowage-js/stowage/blob/@stowage/hono@0.6.0/CONTEXT.md)
and the [decisions behind it](https://github.com/stowage-js/stowage/tree/@stowage/hono@0.6.0/docs/adr)
are at the same tag.

## License

MIT
