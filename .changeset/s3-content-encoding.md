---
"@stowage/adapter-s3": minor
---

`stat`, `get`, `copy` and `move` report `contentEncoding`, the content coding an object is stored with, from the `HEAD` or `GET` they already send, the `HEAD` of the destination for `copy` and `move`; `identity` and an empty value read as none. `put` reports none (ADR 0061).
