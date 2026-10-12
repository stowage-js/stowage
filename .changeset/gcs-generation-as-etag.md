---
"@stowage/adapter-gcs": minor
---

**Breaking:** `etag` on `adapter-gcs` is the object's generation, not the JSON `etag` GCS reports, on every `ObjectStat` that `put`, `stat`, `get`, `copy` and `move` resolve with and on every `ObjectEntry` of a listing, so an `etag` kept from v0.6 no longer matches. GCS checks a precondition against the generation alone and ignores `If-Match` on an upload, so the generation is the one value a precondition can name. A change another tool makes to the content headers or the user metadata alone keeps the generation, so `etag` no longer moves on it, and `serveObject` may answer `304` to a client whose cached content headers are older than the object's. An answer that feeds a description or a listing entry without `generation` is `ProviderError` (spec 9.4, ADR 0070, ADR 0071).
