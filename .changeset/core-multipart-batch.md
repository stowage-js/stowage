---
"@stowage/core": minor
"@stowage/adapter-azure-blob": patch
---

`@stowage/core` exports the `multipart/mixed` batch that Blob Batch on Azure and the batch endpoint of the GCS JSON API share: `batchBoundary`, `batchContentType`, `batchBody`, which writes each subrequest as an `application/http` part numbered by its place, and `readSubresponses`, which reads the answer's subresponses and pairs each to its subrequest by the `Content-ID` form the adapter names. An answer it cannot read comes back as `unreadable` or `unanswered`, which the adapter raises as `ProviderError` (spec 4.13). `adapter-azure-blob` sends and reads its Blob Batch through them and no longer holds a copy; its behavior does not change.
