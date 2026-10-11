---
"@stowage/core": minor
---

`sendRequest` takes `precondition` on a request that carries one: where an attempt received no response or answered a `5xx`, a later attempt refused as `PreconditionFailed` rejects with that earlier failure, `retryable: true` and `attempts` counting every attempt, because the repeat of a request that took effect meets its own result (ADR 0073). `408` and `429` leave no such doubt. `alsoRefusedBy` names provider codes that count as the refusal as well, such as `NoSuchUpload` on a conditional `CompleteMultipartUpload` (spec 7.5). The type is exported as `PreconditionRule`. `sendRequest` stays outside the spec, and `withRetry` is unchanged.
