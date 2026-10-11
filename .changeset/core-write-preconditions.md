---
"@stowage/core": minor
---

`PutOptions` takes `onlyIf?: Precondition`, where `Precondition` is `"absent" | { etag: string }`, and `copy` and `move` on `Storage` take the new `CopyOptions`, whose `onlyIf` applies to `to`. `StorageErrorCode` gains `PreconditionFailed`, raised with `retryable: false` where the precondition did not hold. `capabilityNames` gains `writeIfAbsent` and `writeIfUnchanged`, last in its order. `preconditionRefusal` gives an adapter the checks of spec 4.3 for `onlyIf`, in their order: `Unsupported` naming the capability the form needs, a string `writeIfAbsent` and an object `writeIfUnchanged`, whatever it holds; then `InvalidOption` naming `onlyIf` for a value of neither form, a string other than `"absent"`, and an `etag` that is no non-empty string of visible ASCII, holds a `"` or starts with `W/` (ADR 0070, ADR 0076).
