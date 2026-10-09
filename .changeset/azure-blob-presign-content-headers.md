---
"@stowage/adapter-azure-blob": minor
---

`presignPut` takes `cacheControl`, `contentDisposition` and `contentLanguage` as optional options. Each one given is checked as `put` checks it, the content type counted in the 2,048 bytes, before the user delegation key is requested, with `attempts: 0`; named in `srh` as `x-ms-blob-cache-control`, `x-ms-blob-content-disposition` or `x-ms-blob-content-language`, appended after `x-ms-blob-content-type` in that order; and returned in `headers` under that name, so the browser still sends `headers` as they come. `Put Blob` stores no standard `Content-Disposition` and lets an `x-ms-blob-*` header override the standard one, so the standard names would bind nothing. A content header left out is not bound: whoever holds the URL may send it, and Azure stores it. Where the options are used, the account's CORS rule has to allow the headers they bind. Azure refuses an upload whose value differs from the signed one or is missing (spec 8.9, ADR 0063).
