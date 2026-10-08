---
"@stowage/adapter-gcs": minor
---

`presignPut` takes `cacheControl`, `contentDisposition` and `contentLanguage` as optional options. Each one given is checked as `put` checks it, the content type counted in the 2,048 bytes, before anything is sent, with `attempts: 0`; added to the signed headers as `cache-control`, `content-disposition` or `content-language`; and returned in `headers` under that name, so the browser still sends `headers` as they come. GCS refuses an upload whose value differs from the signed one with `403 SignatureDoesNotMatch` and one that leaves it out with `400 MalformedSecurityHeader`. A content header left out is not bound: whoever holds the URL may send it, and GCS stores it. Where the options are used, the bucket's CORS rule has to allow the headers they bind. A caller who passes none signs what it signed before (spec 9.9, ADR 0063).
