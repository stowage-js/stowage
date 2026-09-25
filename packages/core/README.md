# @stowage/core

The types every stowage adapter implements, `StorageError`, and the utilities an adapter calls. It
does nothing without an adapter.

## Install

```sh
npm install @stowage/core
```

## Example

A function written against `Storage` runs against every adapter: `memoryStorage()` in a test,
`fsStorage()` on a laptop, `s3Storage()` in production.

```ts
import { isStorageError, type Storage } from "@stowage/core";

export async function readSettings(storage: Storage): Promise<unknown> {
  try {
    const object = await storage.get("settings.json");

    return await object.json();
  } catch (failure) {
    if (isStorageError(failure) && failure.code === "NotFound") return {};

    throw failure;
  }
}
```

## Runtimes

Node 24 and later, Bun, Deno and `workerd` at the compatibility date `2026-09-01` without Node APIs. CI last ran green on Bun 1.4.2 and Deno 2.9.6.

The bundle measures 1.3 kB minified and gzipped.

## Limits

This section is empty. `@stowage/core` declares no capability; each storage declares its own, out
of the five names of [spec 4.9](https://github.com/stowage-js/stowage/blob/@stowage/core@0.1.0/docs/spec.md#49-capabilities).

## Notes

A failure reaches the caller in one of two shapes: a `StorageError`, which `isStorageError` tells
apart, or the runtime's `AbortError` once a signal fired
([spec 4.10](https://github.com/stowage-js/stowage/blob/@stowage/core@0.1.0/docs/spec.md#410-errors)).
A name added to `StorageErrorCode` or `capabilityNames` is a minor release, so a `switch` over
either needs a default branch
([spec 9](https://github.com/stowage-js/stowage/blob/@stowage/core@0.1.0/docs/spec.md#9-versions)).

```ts
import { isStorageError } from "@stowage/core";

export function describeFailure(failure: unknown): string {
  if (failure instanceof Error && failure.name === "AbortError") return "canceled";
  if (!isStorageError(failure)) throw failure;

  switch (failure.code) {
    case "NotFound":
      return "missing";
    case "AccessDenied":
    case "InvalidCredentials":
    case "Expired":
      return "refused";
    default:
      return failure.retryable ? "try again" : "failed";
  }
}
```

## Specification

[`docs/spec.md` at `@stowage/core@0.1.0`](https://github.com/stowage-js/stowage/blob/@stowage/core@0.1.0/docs/spec.md#4-the-core-api-stowagecore)
is the contract: a caller may rely on what it states and on nothing else this package happens to
export. The [terms it uses](https://github.com/stowage-js/stowage/blob/@stowage/core@0.1.0/CONTEXT.md)
and the [decisions behind it](https://github.com/stowage-js/stowage/tree/@stowage/core@0.1.0/docs/adr)
are at the same tag.

## License

MIT
