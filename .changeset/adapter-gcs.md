---
"@stowage/adapter-gcs": minor
---

Add `@stowage/adapter-gcs`, a storage in one bucket of Google Cloud Storage on the JSON API. `gcsStorage` validates its configuration and its `signer` at construction and resolves the access token before every request that carries it, sending it as `Authorization: Bearer`. `put` of held bytes goes as one `uploadType=multipart` request, `get` sends the resource request and the media download side by side, and `stat` and `exists` read the object's resource (spec 9, ADR 0031, ADR 0033). A failure is read from the JSON API's error document whatever its `Content-Type`, a `404` means absence only with the reason `notFound` outside the media download, a missing bucket is `NotFound` without `key` and `exists` rethrows it, transient failures are repeated on the core's `withRetry`, and a token refused as `invalid_token` is resolved once more under `forceRefresh` (spec 9.3, 9.5, 9.8, ADR 0038).
