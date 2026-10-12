---
"@stowage/adapter-fs": minor
---

`adapter-fs` declares `writeIfAbsent`. `put` and `copy` with `onlyIf: "absent"` fill their temporary file as every write does, then link it to the key's path with `link(2)`, which refuses a name that holds anything, atomically against every other process. A `move` with `onlyIf: "absent"` links the source, or the file a symbolic link at the source resolves to, and then removes the source. A key that holds an object rejects with `PreconditionFailed` and keeps what it held; a directory or a link that resolves to no object below the root is `InvalidRequest`. On a file system without hard links, the `link` is `ProviderError` with `retryable: false`. `onlyIf: { etag }` stays `Unsupported` naming `writeIfUnchanged`, and writes without `onlyIf` keep ending in `rename` (ADR 0072).
