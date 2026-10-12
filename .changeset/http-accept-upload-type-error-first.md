---
"@stowage/http": patch
---

`acceptUpload` rejects with its `TypeError` for a request body read before the call whatever the method, where a method other than `PUT` was answered `405` before, so the caller's mistake comes before any refusal of the client's request (spec 10.5, ADR 0052).
