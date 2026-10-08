---
"@stowage/adapter-s3": minor
---

`adapter-s3` declares `contentHeaders`. `put` sends `cacheControl`, `contentDisposition` and `contentLanguage` as `Cache-Control`, `Content-Disposition` and `Content-Language` on `PutObject` and on `CreateMultipartUpload`, and `put`, `stat`, `get`, `copy` and `move` report them as stored; an empty stored value reads as none. A value the checks of spec 4.3 refuse is refused before anything is sent, with `attempts: 0`, where it was `Unsupported` before (ADR 0058, ADR 0059).
