---
"@stowage/core": minor
---

`@stowage/core` exports `sendRequest` and `readMaxAttempts`, which `adapter-s3`, `adapter-azure-blob` and `adapter-gcs` send their requests and read their `retry` option through. They are not part of the spec and may change in any minor release (ADR 0057). An adapter written elsewhere repeats through `withRetry`, which spec 4.13 keeps.
