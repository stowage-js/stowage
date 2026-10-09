---
"@stowage/adapter-s3": minor
---

A request whose credential carries a `sessionToken` and that the provider answers with `SignatureDoesNotMatch` is refreshed once: the resolver is called with `{ forceRefresh: true }` and the request is signed and sent again, without a delay and whatever `retry` says. This is how R2 answers a temporary credential past its `exp`, which until now failed after one attempt. Where the fresh credential is refused too, the failure is `InvalidCredentials` with `attempts: 2`, and its message says that the temporary credential expired or is not accepted. A credential without a `sessionToken` keeps the single attempt, and `stat` and `exists`, whose `HEAD` carries no provider code, get no refresh (spec 7.2, 7.3, ADR 0065).
