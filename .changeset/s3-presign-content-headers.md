---
"@stowage/adapter-s3": minor
---

`presignPut` takes `cacheControl`, `contentDisposition` and `contentLanguage` as optional options. Each one given is checked as `put` checks it, the content type counted in the 2,048 bytes, before the credential is resolved, with `attempts: 0`; signed as `Cache-Control`, `Content-Disposition` or `Content-Language`; and returned in `headers` under that name in lower case, so the browser still sends `headers` as they come. AWS and R2 refuse an upload whose value differs from the signed one or leaves it out with `403`. A content header left out is not bound: whoever holds the URL may send it, and the provider stores it. Where the options are used, the bucket's CORS rule has to allow the headers they bind. A caller who passes none signs what it signed before (spec 7.10, ADR 0063).
