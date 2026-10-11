---
"@stowage/core": minor
---

`capabilityNames` gains `deleteIfUnchanged`, second in its order. `preconditionRefusal` takes `"delete"` beside `"write"`: there an `onlyIf` object needs `deleteIfUnchanged`, and any string, `"absent"` included, is `InvalidOption` naming `onlyIf` on every storage, since "absent" has no kind on a delete (ADR 0070).
