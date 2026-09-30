# @stowage/core

The types every stowage adapter implements, `StorageError`, and the utilities an adapter calls. It
does nothing without an adapter.

## Install

```sh
npm install @stowage/core
```

## Example

A function written against `Storage` runs against every adapter: `memoryStorage()` in a test,
`fsStorage()` on a laptop, `s3Storage()`, `azureBlobStorage()` or `gcsStorage()` in production.

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

The bundle measures 5.9 kB minified and gzipped.

## Limits

This section is empty. `@stowage/core` declares no capability; each storage declares its own, out
of the five names of [spec 4.9](https://github.com/stowage-js/stowage/blob/@stowage/core@0.3.0/docs/spec.md#49-capabilities).

## Notes

A failure reaches the caller in one of two shapes: a `StorageError`, which `isStorageError` tells
apart, or the runtime's `AbortError` once a signal fired
([spec 4.10](https://github.com/stowage-js/stowage/blob/@stowage/core@0.3.0/docs/spec.md#410-errors)).
A name added to `StorageErrorCode` or `capabilityNames` is a minor release, so a `switch` over
either needs a default branch
([spec 11](https://github.com/stowage-js/stowage/blob/@stowage/core@0.3.0/docs/spec.md#11-versions)).

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

An adapter written outside this repository takes what two adapters here need on the wire from
this package rather than writing it again
([spec 4.13](https://github.com/stowage-js/stowage/blob/@stowage/core@0.3.0/docs/spec.md#413-exports-for-adapter-authors)):

- `invalidKeyReason` checks a key against its rule of spec 4.8, as the first act of every
  operation.
- `errorCodeForStatus` and `isTransientStatus` are the status mapping of spec 4.10, and
  `withRetry` the retry loop around one request.
- `parseXml` reads the XML an answer document is written in, and rejects anything outside that
  subset with `XmlSyntaxError`.
- `readEnvironment` reads one environment variable, and answers `""` where it is unset or the
  runtime cannot read it.
- `isUserMetadataKey`, `encodeUserMetadataValue`, `decodeUserMetadataValue` and
  `userMetadataByteLength` carry user metadata in headers, and measure the 2 KB of spec 4.3.
- `PresignedPut` is what `presignPut` resolves with on every adapter that declares
  `presignedUrls`.

```ts
import { invalidKeyReason, StorageError } from "@stowage/core";

export function requireWritableKey(bucket: string, key: string): void {
  const reason = invalidKeyReason(key, "writable");

  if (reason === undefined) return;

  throw new StorageError({
    code: "InvalidKey",
    message: reason,
    operation: "put",
    bucket,
    provider: "my-provider",
    key,
    attempts: 0,
  });
}
```

## Specification

[`docs/spec.md` at `@stowage/core@0.3.0`](https://github.com/stowage-js/stowage/blob/@stowage/core@0.3.0/docs/spec.md#4-the-core-api-stowagecore)
is the contract: a caller may rely on what it states and on nothing else this package happens to
export. The [terms it uses](https://github.com/stowage-js/stowage/blob/@stowage/core@0.3.0/CONTEXT.md)
and the [decisions behind it](https://github.com/stowage-js/stowage/tree/@stowage/core@0.3.0/docs/adr)
are at the same tag.

## License

MIT
