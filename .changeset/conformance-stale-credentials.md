---
"@stowage/conformance": minor
---

The suite gains `errors/stale-credentials`, which runs where a target supplies the new optional factory `createStorageWithStaleCredentials(onRefresh)`: a storage whose resolver answers a credential the provider refuses until it is asked with `forceRefresh: true`, a fresh one from then on, and calls `onRefresh` on each refresh. `get`, `stat` and `put`, each on a storage of its own, succeed after at least one refresh (spec 14.5, ADR 0067).
