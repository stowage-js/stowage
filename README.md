# stowage

stowage puts object storage providers behind one typed API, so that an application developed
against local disk runs against a cloud provider by changing where the storage is constructed, and
nothing else.

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

## Packages

| Package                                              | Contents                                                        |
| ---------------------------------------------------- | --------------------------------------------------------------- |
| [`@stowage/core`](packages/core)                     | The types of the parity core, `StorageError`, adapter utilities |
| [`@stowage/adapter-memory`](packages/adapter-memory) | A storage held in process memory                                |
| [`@stowage/adapter-fs`](packages/adapter-fs)         | A storage rooted in one directory of the local file system      |
| [`@stowage/adapter-s3`](packages/adapter-s3)         | A storage in one bucket of AWS S3 or Cloudflare R2              |
| [`@stowage/conformance`](packages/conformance)       | The cases every adapter has to pass                             |

The five packages carry one version number and are released together. Which package runs where is
the [runtime matrix](docs/spec.md#2-runtime-matrix).

## A large upload from a server

A server writes a stream of unknown length under a key, here the body of an incoming request. The
stream travels to S3 in parts, so memory does not grow with the size of the object, and an upload
that fails partway is aborted at the provider. This is
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

## Documentation

- [The specification](docs/spec.md), which is the contract: a caller may rely on what it states
  and on nothing else a package happens to export
- [The terms it uses](CONTEXT.md)
- [The decisions behind it](docs/adr)

## License

MIT
