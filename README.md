# stowage

stowage puts object storage providers behind one typed API, so that an application developed
against local disk runs against a cloud provider by changing where the storage is constructed, and
nothing else.

[![npm](https://img.shields.io/npm/v/@stowage/core)](https://www.npmjs.com/package/@stowage/core)
[![CI](https://github.com/stowage-js/stowage/actions/workflows/ci.yml/badge.svg?branch=main)](https://github.com/stowage-js/stowage/actions/workflows/ci.yml)
[![License](https://img.shields.io/github/license/stowage-js/stowage)](LICENSE)

stowage is below 1.0: a minor release may withdraw a promise, and its changelog marks that change
as breaking. 1.0 waits for what [spec 15](docs/spec.md#15-versions) names.

```sh
npm install @stowage/adapter-fs @stowage/adapter-s3
```

Both blocks are ES modules, so they run from an `.mjs` file or in a package with
`"type": "module"`, and `root` names an absolute path to a directory that exists.

```ts
import { fsStorage } from "@stowage/adapter-fs";

const storage = fsStorage({ root: "/var/lib/my-app/storage" });

await storage.put("notes/hello.txt", "Hello, world");

const object = await storage.get("notes/hello.txt");
console.log(await object.text());

for await (const entry of storage.list({ prefix: "notes/" })) {
  console.log(entry.key, entry.size);
}

await storage.delete("notes/hello.txt");
```

```ts
import { fromEnv, s3Storage } from "@stowage/adapter-s3";

const storage = s3Storage({ bucket: "my-app-storage", region: "eu-north-1", credentials: fromEnv });

await storage.put("notes/hello.txt", "Hello, world");

const object = await storage.get("notes/hello.txt");
console.log(await object.text());

for await (const entry of storage.list({ prefix: "notes/" })) {
  console.log(entry.key, entry.size);
}

await storage.delete("notes/hello.txt");
```

## Why stowage

- **No SDK beneath an adapter.** The adapters for S3, Azure Blob and GCS speak their provider's
  wire protocol themselves, over `fetch`, Web Crypto and web streams, and depend on
  `@stowage/core` alone ([ADR 0003](docs/adr/0003-own-the-s3-wire-protocol.md)). As measured for
  0.6.0, each of them stays under 15 kB minified and gzipped with `@stowage/core` included
  ([`adapter-s3`](packages/adapter-s3#runtimes),
  [`adapter-azure-blob`](packages/adapter-azure-blob#runtimes),
  [`adapter-gcs`](packages/adapter-gcs#runtimes)).
- **Node, Bun, Deno and `workerd`.** Every adapter but `adapter-fs` runs on all four, on `workerd`
  without Node APIs ([the runtime matrix](docs/spec.md#2-runtime-matrix)).
- **Run against the providers themselves.** One conformance suite runs every adapter against an
  emulator on each pull request, and against AWS S3, Cloudflare R2, Azure Blob Storage and Google
  Cloud Storage every day and before each release ([`@stowage/conformance`](packages/conformance)).
- **Failures to switch on.** A failure is a `StorageError` carrying one of ten codes, and a missing
  object is `NotFound` on every provider ([spec 4.10](docs/spec.md#410-errors)).
- **Promises written down.** What a caller may rely on is what [the specification](docs/spec.md)
  states, and what a provider cannot hold is a capability its storage does not declare
  ([spec 4.9](docs/spec.md#49-capabilities)).

## When not to use stowage

- You need what a provider offers beyond objects: versioning, object lock, tagging, storage
  classes, ACLs or encryption keys of your own. Use the provider's SDK for those, beside
  stowage or instead of it.
- You need a key-value store rather than objects, with values you read and write whole by key.
  [unstorage](https://unstorage.unjs.io) is built for that.
- You create, list or delete buckets and containers from your application.
- You want credentials found for you through instance metadata, a managed identity or workload
  identity federation. stowage takes static credentials, `fromEnv`, or an access token your own
  resolver obtains.
- Your endpoint is not one of the providers stowage promises. MinIO and other endpoints that speak
  a promised provider's wire protocol are each a [compatible endpoint](CONTEXT.md): the adapter for
  that protocol can be configured for them, and stowage promises nothing against them.

The full list is [spec 17](docs/spec.md#17-non-goals).

## Packages

| Package                                                      | Contents                                                        |
| ------------------------------------------------------------ | --------------------------------------------------------------- |
| [`@stowage/core`](packages/core)                             | The types of the parity core, `StorageError`, adapter utilities |
| [`@stowage/adapter-memory`](packages/adapter-memory)         | A storage held in process memory                                |
| [`@stowage/adapter-fs`](packages/adapter-fs)                 | A storage rooted in one directory of the local file system      |
| [`@stowage/adapter-s3`](packages/adapter-s3)                 | A storage in one bucket of AWS S3 or Cloudflare R2              |
| [`@stowage/adapter-azure-blob`](packages/adapter-azure-blob) | A storage in one container of an Azure Blob Storage account     |
| [`@stowage/adapter-gcs`](packages/adapter-gcs)               | A storage in one bucket of Google Cloud Storage                 |
| [`@stowage/http`](packages/http)                             | The HTTP layer and the Node bridge                              |
| [`@stowage/nestjs`](packages/nestjs)                         | The integration for NestJS 12                                   |
| [`@stowage/hono`](packages/hono)                             | The integration for Hono 4                                      |
| [`@stowage/nextjs`](packages/nextjs)                         | The integration for Next.js 16                                  |
| [`@stowage/conformance`](packages/conformance)               | The cases every adapter and every server has to pass            |

The eleven packages carry one version number and are released together. Which package runs where is
the [runtime matrix](docs/spec.md#2-runtime-matrix).

## A large upload from a server

A server writes a stream of unknown length under a key, here the body of an incoming request. The
stream travels to S3 in parts, so memory does not grow with the size of the object, and an upload
that fails partway leaves no multipart upload behind, except in the one case spec 7.7 names. This is
[reference flow 1](docs/spec.md#flow-1-large-upload-from-a-server).

```ts
import { fromEnv, s3Storage } from "@stowage/adapter-s3";

const storage = s3Storage({ bucket: "my-app-uploads", region: "eu-north-1", credentials: fromEnv });

export async function upload(request: Request, key: string): Promise<Response> {
  if (request.body === null) return new Response("The request carries no body", { status: 400 });

  const stat = await storage.put(key, request.body, {
    contentType: request.headers.get("content-type") ?? undefined,
    signal: request.signal,
  });

  return Response.json({ key: stat.key, size: stat.size });
}
```

A route that takes uploads from clients needs a size limit in front of `put`, which
[`acceptUpload`](packages/http) of `@stowage/http` enforces while the body streams, and
[`@stowage/nestjs`](packages/nestjs), [`@stowage/hono`](packages/hono) and
[`@stowage/nextjs`](packages/nextjs) hand it a storage in those frameworks.

## Documentation

- [The specification](docs/spec.md), which is the contract: a caller may rely on what it states
  and on nothing else a package happens to export
- [The terms it uses](CONTEXT.md)
- [The decisions behind it](docs/adr)

## License

MIT
