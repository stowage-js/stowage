---
"@stowage/adapter-memory": minor
"@stowage/adapter-fs": minor
"@stowage/adapter-s3": minor
"@stowage/adapter-azure-blob": minor
"@stowage/adapter-gcs": minor
---

`delete` takes one key with options, `delete(key, options)`, beside the variadic form. Without `onlyIf` it deletes the key as `delete(key)` does, under the caller's signal: a signal already aborted rejects with `AbortError` before any request, and an invalid key is the report's `InvalidKey` entry. An option key the form does not list is `InvalidOption`. `adapter-fs`, `adapter-s3`, `adapter-azure-blob` and `adapter-gcs` refuse an `onlyIf` object as `Unsupported` naming `deleteIfUnchanged`, and any string as `InvalidOption` naming `onlyIf`, each with `attempts: 0` and before anything is sent or removed. `adapter-s3` and `adapter-fs` never declare `deleteIfUnchanged`: R2 drops the precondition of a delete in silence, and a file system reports no `etag` (ADR 0071, ADR 0072).
