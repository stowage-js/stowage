---
"@stowage/adapter-s3": minor
---

**Breaking:** `adapter-s3` no longer answers a missing bucket like a missing object. `exists` in a bucket AWS names as missing rejected nothing and answered `false`, and the `NotFound` of every operation named the key, so a wrong bucket name read as an absent object. Now `NoSuchBucket` is `NotFound` without `key` on every operation, `delete` and `deleteAll` included, and `exists` answers `false` for a `NotFound` carrying `key` alone and rethrows every other failure. A `HEAD` cannot tell the two apart, so a `404` to the `HEAD` of `stat` or `exists` is followed by one `GET` of the same key with `Range: bytes=0-0`: an absent key costs two requests, and one that exists still costs one. Only a body naming `NoSuchBucket` changes the answer, and a `GET` that receives no response rejects with `NetworkError`. On R2 under a token scoped to other buckets, a missing bucket stays `AccessDenied` (spec 4.10, 7.2, 7.9, ADR 0043).
