# @stowage/http

The HTTP layer of stowage: it answers a web `Request` on a storage's behalf for a key the caller
has already named, and resolves with a web `Response`. A server that cannot send a web `Response`
reaches it through the Node bridge.

## Install

```sh
npm install @stowage/http @stowage/adapter-s3
```

## Example

A `fetch` handler serves the objects below `/files/` and accepts uploads of up to 100 MiB there.
Routing, authorization and naming the key stay with the application; the layer reads no URL.

```ts
import { fromEnv, s3Storage } from "@stowage/adapter-s3";
import { acceptUpload, serveObject } from "@stowage/http";

const storage = s3Storage({ bucket: "my-app-files", region: "eu-north-1", credentials: fromEnv });

export default {
  async fetch(request: Request): Promise<Response> {
    const { pathname } = new URL(request.url);

    if (!pathname.startsWith("/files/")) return new Response(null, { status: 404 });

    const key = `files/${decodeURIComponent(pathname.slice("/files/".length))}`;

    switch (request.method) {
      case "GET":
      case "HEAD":
        return await serveObject(storage, key, request);
      case "PUT":
        return await acceptUpload(storage, key, request, { maxSize: 100 * 1024 * 1024 });
      default:
        return new Response(null, { status: 405, headers: { allow: "GET, HEAD, PUT" } });
    }
  },
};
```

`serveObject` streams the object from `get`, answers one byte range and the preconditions of RFC
9110, and a `HEAD` from `stat`. `acceptUpload` streams the body into `put` and answers `413` once it
passes `maxSize`, before the provider sees its end. Every answer is a `Response` whose headers the
application may still change. A `StorageError` becomes a status with an empty body, and
`storageErrorOf(response)` hands it back for logging
([spec 10.2](https://github.com/stowage-js/stowage/blob/@stowage/http@0.5.0/docs/spec.md#102-answers)).

`Bun.serve` and `Deno.serve` take the handler as it is. `redirectToObject` and `presignUpload` take
a storage that declares `presignedUrls`, and fail to compile on one that does not
([spec 10.1](https://github.com/stowage-js/stowage/blob/@stowage/http@0.5.0/docs/spec.md#101-exports)).

## Runtimes

Node 24 and later, Bun, Deno and `workerd` at the compatibility date `2026-09-01` without Node APIs. CI last ran green on Bun 1.4.2 and Deno 2.9.6.

| Server          | Node | Bun | Deno | `workerd` |
| --------------- | ---- | --- | ---- | --------- |
| `@stowage/http` | yes  | yes | yes  | yes       |
| the Node bridge | yes  | yes | yes  | no        |

These are the package's cells in the
[runtime matrix](https://github.com/stowage-js/stowage/blob/@stowage/http@0.5.0/docs/spec.md#2-runtime-matrix).
The Node bridge covers Node, Bun and Deno, and not `workerd`, where the package loads but no
`node:http` server hands it a request.

The bundle measures 4.9 kB minified and gzipped, `@stowage/core` included.

## Limits

- `redirectToObject` answers a `HEAD` with the same `302` as a `GET`, to a URL that S3 and GCS sign
  for `GET` alone. A client following that `302` with `HEAD` is answered `403` by the provider. A
  route that has to answer `HEAD` serves through `serveObject`
  ([spec 10.4](https://github.com/stowage-js/stowage/blob/@stowage/http@0.5.0/docs/spec.md#104-redirecting-to-an-object)).

## Notes

### Express through the Node bridge

`toWebRequest(req, res)` builds the web `Request` from an Express request, and
`writeResponse(res, response)` writes the answer back
([spec 10.7](https://github.com/stowage-js/stowage/blob/@stowage/http@0.5.0/docs/spec.md#107-the-node-bridge)).
Express routes a `HEAD` to the `GET` handler, and the bridge keeps its method:

```ts
import { fromEnv, s3Storage } from "@stowage/adapter-s3";
import { acceptUpload, serveObject, toWebRequest, writeResponse } from "@stowage/http";
import express from "express";

const storage = s3Storage({ bucket: "my-app-files", region: "eu-north-1", credentials: fromEnv });
const app = express();

app.get("/files/:name", async (req, res) => {
  const response = await serveObject(storage, `files/${req.params.name}`, toWebRequest(req, res));

  await writeResponse(res, response);
});

app.put("/files/:name", async (req, res) => {
  const response = await acceptUpload(storage, `files/${req.params.name}`, toWebRequest(req, res), {
    maxSize: 100 * 1024 * 1024,
  });

  await writeResponse(res, response);
});

app.listen(3000);
```

### Fastify through `reply.hijack()`

Fastify reads an `application/json` or `text/plain` body itself, before the handler runs. Only an
application-wide content type parser that leaves the payload unread lets the body stream, behind
`removeAllContentTypeParsers()`. That parser switches Fastify's `bodyLimit` off, so `maxSize` is
the upload's only limit, and a route that needs a parsed body parses it itself. `reply.hijack()`
keeps Fastify from answering on its own once the handler returns:

```ts
import { fromEnv, s3Storage } from "@stowage/adapter-s3";
import { acceptUpload, toWebRequest, writeResponse } from "@stowage/http";
import Fastify from "fastify";

const storage = s3Storage({ bucket: "my-app-files", region: "eu-north-1", credentials: fromEnv });
const app = Fastify();

app.removeAllContentTypeParsers();
app.addContentTypeParser("*", (_request, _payload, done) => done(null));

app.put<{ Params: { name: string } }>("/files/:name", async (request, reply) => {
  reply.hijack();

  const response = await acceptUpload(
    storage,
    `files/${request.params.name}`,
    toWebRequest(request.raw, reply.raw),
    { maxSize: 100 * 1024 * 1024 },
  );

  await writeResponse(reply.raw, response);
});

await app.listen({ port: 3000 });
```

### Bun's body limit

`Bun.serve` refuses a body above 128 MiB, its default `maxRequestBodySize`, before the handler
runs. A route whose `maxSize` is above that raises `maxRequestBodySize` as well.

### Keep the body unread

`acceptUpload` reads `request.body` itself. A body read before it, by `request.json()`, a
validator or a body parser, makes it reject with a `TypeError` before `put` starts, and
`toWebRequest` throws one for a Node request whose body a parser such as `express.json()` read
([spec 10.5](https://github.com/stowage-js/stowage/blob/@stowage/http@0.5.0/docs/spec.md#105-accepting-an-upload)).
A parser mounted with `app.use` in front of every route reaches the upload routes too.

## Specification

[`docs/spec.md` at `@stowage/http@0.5.0`](https://github.com/stowage-js/stowage/blob/@stowage/http@0.5.0/docs/spec.md#10-stowagehttp)
is the contract: a caller may rely on what it states and on nothing else this package happens to
export. The [terms it uses](https://github.com/stowage-js/stowage/blob/@stowage/http@0.5.0/CONTEXT.md)
and the [decisions behind it](https://github.com/stowage-js/stowage/tree/@stowage/http@0.5.0/docs/adr)
are at the same tag.

## License

MIT
