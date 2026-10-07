---
"@stowage/adapter-memory": minor
---

`adapter-memory` declares `contentHeaders`. `put` stores `cacheControl`, `contentDisposition` and `contentLanguage`, and `put`, `stat`, `get`, `copy` and `move` report them byte for byte. A value the checks of spec 4.3 refuse is refused before anything is written, with `attempts: 0` (ADR 0060).
