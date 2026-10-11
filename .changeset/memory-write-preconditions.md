---
"@stowage/adapter-memory": minor
---

`adapter-memory` declares `writeIfAbsent` and `writeIfUnchanged`. `put`, `copy` and `move` take `onlyIf: "absent"` or `onlyIf: { etag }`, checked in the synchronous step that stores the object, after the body is read and its `etag` computed, so no other call on the storage runs between the check and the store. A precondition that does not hold rejects with `PreconditionFailed`, `retryable: false` and without `status` or `providerCode`, and leaves the key as it was; a `move` refused at `to` leaves `from` in place. A write of the same bytes keeps the `etag`, so a precondition naming it still holds (ADR 0072).
