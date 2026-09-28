---
"@stowage/core": minor
"@stowage/adapter-s3": patch
"@stowage/adapter-azure-blob": patch
---

`@stowage/core` exports `uploadStream`, the one definition of reading a streamed body into parts of `partSize` and sending them with `concurrency` in flight. An adapter passes `whole` for a stream that ends within the first part and `multipart` to start, send through `sendParts` and commit. The core checks the adapter's `maxParts` and keeps the part reader, the buffers and the cancellation of the source to itself (spec 4.13, ADR 0030). `adapter-s3` and `adapter-azure-blob` upload streams through it and no longer hold a copy each.
