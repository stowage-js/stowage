---
"@stowage/conformance": minor
---

The suite gains `presign/put-content-headers` (`fast`) and `presign/put-rejects-content-headers` (`slow`), each requiring `presignedUrls` and `contentHeaders`. The first signs `cacheControl`, `contentDisposition` and `contentLanguage`, uploads with the returned `headers` and has `stat` report the three byte for byte and no `contentEncoding`; the second has an upload sending one of them with another value, and one leaving it out, each answer `4xx`. A storage declaring `presignedUrls` without `contentHeaders` refuses a `presignPut` carrying any of the three as `Unsupported` naming `contentHeaders`, with `attempts: 0`, and signs one carrying none. A third-party adapter declaring both that refuses the three as unknown options fails the cases until it handles them (spec 14.5, ADR 0063, ADR 0064).
