---
"@stowage/adapter-azure-blob": minor
---

**Breaking:** `presignPut` on `adapter-azure-blob` binds `x-ms-blob-content-type` as well. Its SAS carries `srh=content-type,content-length,x-ms-blob-type,x-ms-blob-content-type`, and `headers` gains `x-ms-blob-content-type`, the content type again. `Put Blob` stores an `x-ms-blob-content-type` in place of `Content-Type`, so a client outside a browser could store another type than the one the URL bound by sending one unsigned. A browser sends `headers` as they come, so its upload is preflighted with the new header: a deployed CORS rule must allow `x-ms-blob-content-type` beside `content-type` and `x-ms-blob-type`, or the browser refuses the upload. This narrows what flow 2 required of the account, a conflict with ADR 0017, under which taking a promise out of the spec takes it from the caller whether or not a line of code moves (spec 3, 8.9, ADR 0063).
