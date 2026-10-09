---
"@stowage/conformance": minor
---

The suite gains `put/content-headers`, `put/content-headers-multipart`, `put/content-headers-refused`, `copy/content-headers` and `move/content-headers`, each requiring `contentHeaders`. A storage declaring it keeps `cacheControl`, `contentDisposition` and `contentLanguage` byte for byte, and through `copy` and `move` a `contentType` with a parameter too, refuses what the checks of spec 4.3 refuse and keeps what meets their bounds exactly; a storage without it refuses any of the three as `Unsupported` naming `contentHeaders`, `""` included, and reports none. Every description these cases read carries no `contentEncoding`. A third-party adapter that refuses the three as unknown options fails the cases until it handles them (ADR 0058, ADR 0060, ADR 0064, ADR 0068).
