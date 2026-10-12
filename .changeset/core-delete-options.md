---
"@stowage/core": minor
---

`DeleteOptions` extends `OperationOptions` with `onlyIf?: { etag: string }`. Without `onlyIf` the form of `delete` for one key deletes the key as `delete(key)` does, under the caller's signal; with it, it deletes only the object `etag` describes, in one request never part of a batch, and reports a failed precondition as the key's `PreconditionFailed` entry. `capabilityNames` gains `deleteIfUnchanged`, second in its order. `preconditionRefusal` takes `"delete"` beside `"write"`: there an `onlyIf` object needs `deleteIfUnchanged`, and any string, `"absent"` included, is `InvalidOption` naming `onlyIf` on every storage, since "absent" has no kind on a delete.
