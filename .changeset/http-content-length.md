---
"@stowage/http": minor
---

`serveObject` answers a `200` and a `HEAD` with `Content-Length: size` where the object has no `contentEncoding`, so a client sees a total and its progress. A content-coded object is answered without `Content-Length` and without `Content-Encoding`, as before, since its bytes may arrive decoded and longer than `size`; a `304` carries no `Content-Length`. Where a precondition or a suffix range has the layer call `stat` first, the `Range` of a coded object is ignored, `bytes=-0` included, and the object is answered `200` without the ranged `get` that would fail; without that `stat`, the whole `get` after a ranged `ProviderError` stays. `Bun.serve` and `workerd` may still drop the length of a streamed `200` on the way to the socket (spec 2, 10.3, ADR 0062).
