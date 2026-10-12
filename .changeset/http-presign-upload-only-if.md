---
"@stowage/http": minor
---

`presignUpload` takes `onlyIf?: Precondition` as an optional option, and `PresignsPut` names it as an optional member of the options it passes. `presignUpload` hands it to `presignPut` where given and never reads it from a request: a caller hands over an `etag` the client sent in the body. A value of the wrong form, checked with `preconditionRefusal` as if every capability were declared, is `400` before signing, so that a client's value never reaches `presignPut` as an `InvalidOption` answered `500`. A storage without the capability the form needs refuses it in `presignPut`, answered `500`. The `PreconditionFailed` `adapter-gcs` gives `presignPut` for an `etag` that is no generation is `412` (spec 10.1, 10.6, ADR 0074).
