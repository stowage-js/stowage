---
"@stowage/adapter-azure-blob": minor
---

**Breaking:** `adapter-azure-blob` no longer answers a missing container like a missing blob. `exists` in a missing container answered `false`, the `NotFound` of every operation named the key, and `delete` reported one `failed` entry per key, so a wrong container name read as an absent object. Now `ContainerNotFound` is `NotFound` without `key` on every operation, and `exists` answers `false` for a `NotFound` carrying `key` alone and rethrows every other failure. A Blob Batch whose subresponses name `ContainerNotFound` rejects the whole `delete`, and `deleteAll` with it, with that `NotFound`; a subresponse answered `404 BlobNotFound` still counts as deleted (spec 4.10, 8.4, 8.8, ADR 0043).
