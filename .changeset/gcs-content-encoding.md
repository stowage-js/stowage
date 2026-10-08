---
"@stowage/adapter-gcs": minor
---

`stat`, `get`, `copy` and `move` report `contentEncoding`, the content coding an object is stored with, from the object resource they already read, never from the media download; `identity` and an empty value read as none. `put` reports none (ADR 0061).
