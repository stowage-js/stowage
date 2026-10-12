---
"@stowage/http": minor
---

A `PreconditionFailed` becomes `412` in every function of the layer, with an empty body, no `ETag` of the object that holds the key, and the error behind it for `storageErrorOf` (spec 10.2, ADR 0075).
