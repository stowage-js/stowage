---
"@stowage/http": minor
---

`@stowage/http` joins the family as the HTTP layer (spec 10, ADR 0046, ADR 0048). `serveObject(storage, key, request, options?)` answers `GET` with the stream of `get` and `HEAD` from `stat`, each with `Content-Type`, `X-Content-Type-Options: nosniff`, `Content-Disposition`, `Cache-Control`, `ETag`, `Last-Modified` and, where the storage declares `rangeReads`, `Accept-Ranges`, and no `Content-Length`; any other method is `405`. A `StorageError` becomes the status of spec 10.2 with an empty body, and `storageErrorOf(response)` answers the error behind it. `toWebRequest` and `writeResponse` carry a web `Request` and `Response` over `node:http` without importing a `node:` module. Ranges, preconditions, redirects and uploads follow.
