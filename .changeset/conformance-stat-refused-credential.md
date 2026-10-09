---
"@stowage/conformance": minor
---

`errors/bad-credentials` asserts that `stat` rejects with `InvalidCredentials`, `retryable: false` and `attempts` of `1` or `2`, as `get` does, and `errors/expired-credentials` that `stat` rejects with `Expired` and `attempts: 2`. An adapter that reads a refused `HEAD` by its status alone and reports `AccessDenied` no longer passes them (spec 14.5, ADR 0066).
