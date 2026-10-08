---
"@stowage/http": minor
---

`serveObject` answers a `200`, a `206`, a `HEAD` and a `304` with the `Content-Language` an object is stored with, and with none where none is stored. `ServeObjectOptions` takes `storedCacheControl`: where it is `true` and the object stores a `cacheControl`, that value is the answer's `Cache-Control`, ahead of `cacheControl` and of `private, no-cache`. A stored `Cache-Control` is never sent without it, since a client that uploaded through a presigned URL, or another tool, may have stored a `public` that would let a shared cache hand one user's object to everyone. Every stored header comes from the `stat` that describes the bytes sent (spec 10.3, ADR 0062).
