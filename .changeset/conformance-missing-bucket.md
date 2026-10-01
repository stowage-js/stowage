---
"@stowage/conformance": minor
---

`ConformanceTarget` gains the optional factory `createStorageWithMissingBucket()`, which returns a storage bound to a bucket, container or root that does not exist and is otherwise configured as the one `createStorage()` returns. A target that leaves it out keeps passing. The new `fast` case `errors/missing-bucket` runs against it: `put`, `get`, `stat`, `exists`, `delete` and the first page of `list` each reject, so an `exists` that answers `false` and a `delete` that returns a report fail the case, and wherever the code is `NotFound`, `key` is unset (spec 4.10, ADR 0043). A target without the factory reports the case `skipped`.
