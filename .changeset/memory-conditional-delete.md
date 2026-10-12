---
"@stowage/adapter-memory": minor
---

`adapter-memory` declares `deleteIfUnchanged`. `delete(key, { onlyIf: { etag } })` deletes the key only where it holds the object `etag` describes, checked in the synchronous step that removes it, so no other call on the storage runs between the check and the removal. A stale `etag` and a key that holds no object each leave one `PreconditionFailed` entry with that `key` in the report, `retryable: false` and without `status` or `providerCode`, and the object stays; a missing key is no success here (ADR 0072).
