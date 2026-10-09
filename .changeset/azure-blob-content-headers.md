---
"@stowage/adapter-azure-blob": minor
---

`adapter-azure-blob` declares `contentHeaders`. `put` sends `cacheControl`, `contentDisposition` and `contentLanguage` as `x-ms-blob-cache-control`, `x-ms-blob-content-disposition` and `x-ms-blob-content-language` on `Put Blob` and on the `Put Block List` of a block upload, and `put`, `stat`, `get`, `copy` and `move` report them as stored; an empty stored value reads as none. `copy` and `move` keep all three byte for byte. A value the checks of spec 4.3 refuse is refused before anything is sent, with `attempts: 0`, where it was `Unsupported` before (ADR 0058, ADR 0059, ADR 0068).
