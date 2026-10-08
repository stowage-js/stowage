---
"@stowage/adapter-gcs": minor
---

`adapter-gcs` declares `contentHeaders`. `put` sends `cacheControl`, `contentDisposition` and `contentLanguage` as members of the object resource, in the body of `uploadType=multipart` and of the start of a resumable session, and `put`, `stat`, `get`, `copy` and `move` report them as the resource holds them; an empty value reads as none. `get` reads them from the resource it already fetches, never from the media download. `copy` and `move` keep them through `rewriteTo` and `objects.move`. A value the checks of spec 4.3 refuse is refused before anything is sent, with `attempts: 0`, where it was `Unsupported` before (ADR 0058, ADR 0059).
