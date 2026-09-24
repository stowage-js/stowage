# @stowage/adapter-fs

A storage rooted in one directory of the local file system.

## Install

```sh
npm install @stowage/adapter-fs
```

## Example

```ts
import { fsStorage } from "@stowage/adapter-fs";

const storage = fsStorage({ root: "/var/lib/my-app/storage" });

await storage.put("reports/2026/q3.csv", "region,revenue\n");

for await (const entry of storage.list({ prefix: "reports/" })) {
  console.log(entry.key, entry.size, entry.lastModified);
}
```

## Runtimes

Node 24 and later, Bun and Deno, on Linux and macOS. `workerd` and Windows are not promised. CI last ran green on Bun 1.4.2 and Deno 2.9.6.

The bundle measures 5.7 kB minified and gzipped, `@stowage/core` included.

## Limits

- `keyBytesPreserved` is not declared: a key comes back Unicode-equivalent to what was written
  ([spec 4.9](https://github.com/stowage-js/stowage/blob/@stowage/adapter-fs@0.1.0/docs/spec.md#49-capabilities)).
- `presignedUrls` is not declared: `FsStorage` has neither `presignGet` nor `presignPut`
  ([spec 4.9](https://github.com/stowage-js/stowage/blob/@stowage/adapter-fs@0.1.0/docs/spec.md#49-capabilities)).
- `userMetadata` is not declared: `put` with a non-empty `userMetadata` is `Unsupported`, and reads
  return `{}`
  ([spec 4.9](https://github.com/stowage-js/stowage/blob/@stowage/adapter-fs@0.1.0/docs/spec.md#49-capabilities)).
- A key segment longer than 255 bytes is `InvalidKey`, and so is a key whose whole path is longer
  than the file system holds. macOS bounds one path at 1024 bytes with the root counted in
  ([spec 6](https://github.com/stowage-js/stowage/blob/@stowage/adapter-fs@0.1.0/docs/spec.md#6-stowageadapter-fs)).
- APFS keeps a name in the Unicode form it was written in, and folds the forms when it looks a name
  up, so a key in NFD reaches the object its NFC form wrote. A case-insensitive file system collides
  keys that differ in case alone. Nothing repairs either
  ([spec 6](https://github.com/stowage-js/stowage/blob/@stowage/adapter-fs@0.1.0/docs/spec.md#6-stowageadapter-fs)).
- The content type is derived from the key's extension, and is `application/octet-stream` where the
  extension is unknown or absent. The `contentType` handed to `put` is not stored, so `stat` may
  report another one
  ([spec 6](https://github.com/stowage-js/stowage/blob/@stowage/adapter-fs@0.1.0/docs/spec.md#6-stowageadapter-fs)).
- No `etag` is set
  ([spec 4.4](https://github.com/stowage-js/stowage/blob/@stowage/adapter-fs@0.1.0/docs/spec.md#44-object-descriptions)).

## Notes

`put` takes no `Blob`. A caller holding one passes its stream
([spec 4.2](https://github.com/stowage-js/stowage/blob/@stowage/adapter-fs@0.1.0/docs/spec.md#42-bodies)):

```ts
import { fsStorage } from "@stowage/adapter-fs";

const storage = fsStorage({ root: "/var/lib/my-app/storage" });
const blob = new Blob(["region,revenue\n"], { type: "text/csv" });

await storage.put("reports/2026/q4.csv", blob.stream());
```

stowage reports no progress
([spec 11](https://github.com/stowage-js/stowage/blob/@stowage/adapter-fs@0.1.0/docs/spec.md#11-non-goals)).
A caller who wants it counts the bytes on their way into `put`:

```ts
import { fsStorage } from "@stowage/adapter-fs";

const storage = fsStorage({ root: "/var/lib/my-app/storage" });

function countBytes(report: (bytes: number) => void): TransformStream<Uint8Array, Uint8Array> {
  let bytes = 0;

  return new TransformStream({
    transform(chunk, controller) {
      bytes += chunk.byteLength;
      report(bytes);
      controller.enqueue(chunk);
    },
  });
}

const response = await fetch("https://example.com/video.mp4");

if (response.body === null) throw new Error("The response carries no body");

await storage.put("videos/intro.mp4", response.body.pipeThrough(countBytes(console.log)));
```

## Specification

[`docs/spec.md` at `@stowage/adapter-fs@0.1.0`](https://github.com/stowage-js/stowage/blob/@stowage/adapter-fs@0.1.0/docs/spec.md#6-stowageadapter-fs)
is the contract: a caller may rely on what it states and on nothing else this package happens to
export. The [terms it uses](https://github.com/stowage-js/stowage/blob/@stowage/adapter-fs@0.1.0/CONTEXT.md)
and the [decisions behind it](https://github.com/stowage-js/stowage/tree/@stowage/adapter-fs@0.1.0/docs/adr)
are at the same tag.

## License

MIT
