---
"@stowage/adapter-gcs": minor
---

Add `@stowage/adapter-gcs`, a storage in one bucket of Google Cloud Storage on the JSON API. `gcsStorage` validates its configuration and its `signer` at construction and resolves the access token before every request that carries it, sending it as `Authorization: Bearer`. `put` of held bytes goes as one `uploadType=multipart` request, `get` sends the resource request and the media download side by side, and `stat` and `exists` read the object's resource (spec 9, ADR 0031, ADR 0033).
