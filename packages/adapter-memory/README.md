# @stowage/adapter-memory

A storage held in process memory, and the implementation a third-party adapter is read against.

## Install

```sh
npm install @stowage/adapter-memory
```

## Example

```ts
import { memoryStorage } from "@stowage/adapter-memory";

const storage = memoryStorage();

await storage.put("greeting.txt", "Hello", {
  contentType: "text/plain",
  userMetadata: { author: "stowage" },
});

const object = await storage.get("greeting.txt");
console.log(object.stat.contentType, object.stat.userMetadata, await object.text());
```

## Runtimes

Node 24 and later, Bun, Deno and `workerd` at the compatibility date `2026-09-01`, with or without `nodejs_compat`. CI last ran green on Bun 1.4.2 and Deno 2.9.6.

The bundle measures 3.3 kB minified and gzipped, `@stowage/core` included.

## Limits

- `presignedUrls` is not declared: `MemoryStorage` has neither `presignGet` nor `presignPut`
  ([spec 4.9](https://github.com/stowage-js/stowage/blob/@stowage/adapter-memory@0.1.0/docs/spec.md#49-capabilities)).
- Every object is held whole in memory, with no size limit of its own, so memory grows with what
  the storage holds ([spec 5](https://github.com/stowage-js/stowage/blob/@stowage/adapter-memory@0.1.0/docs/spec.md#5-stowageadapter-memory)).

## Notes

`put` takes no `Blob`. A caller holding one passes its stream
([spec 4.2](https://github.com/stowage-js/stowage/blob/@stowage/adapter-memory@0.1.0/docs/spec.md#42-bodies)):

```ts
import { memoryStorage } from "@stowage/adapter-memory";

const storage = memoryStorage();
const blob = new Blob(["region,revenue\n"], { type: "text/csv" });

await storage.put("report.csv", blob.stream(), { contentType: blob.type });
```

stowage reports no progress
([spec 11](https://github.com/stowage-js/stowage/blob/@stowage/adapter-memory@0.1.0/docs/spec.md#11-non-goals)).
A caller who wants it counts the bytes on their way into `put`:

```ts
import { memoryStorage } from "@stowage/adapter-memory";

const storage = memoryStorage();

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

const response = await fetch("https://example.com/fixture.json");

if (response.body === null) throw new Error("The response carries no body");

await storage.put("fixture.json", response.body.pipeThrough(countBytes(console.log)));
```

## Specification

[`docs/spec.md` at `@stowage/adapter-memory@0.1.0`](https://github.com/stowage-js/stowage/blob/@stowage/adapter-memory@0.1.0/docs/spec.md#5-stowageadapter-memory)
is the contract: a caller may rely on what it states and on nothing else this package happens to
export. The [terms it uses](https://github.com/stowage-js/stowage/blob/@stowage/adapter-memory@0.1.0/CONTEXT.md)
and the [decisions behind it](https://github.com/stowage-js/stowage/tree/@stowage/adapter-memory@0.1.0/docs/adr)
are at the same tag.

## License

MIT
