---
"@stowage/adapter-fs": minor
---

`adapter-fs` refuses `cacheControl`, `contentDisposition` and `contentLanguage` as `Unsupported` naming `contentHeaders`, `""` included, with `attempts: 0` and before anything is written, where it refused them as unknown options before. It has nowhere to keep them and declares no `contentHeaders`; `stat` and `get` report none (ADR 0060).
