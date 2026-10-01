---
"@stowage/adapter-s3": minor
---

**Breaking:** `adapter-s3` no longer promises `Expired` for an expired credential on R2. Spec 7.9 mapped R2's `ExpiredRequest` to `Expired` provisionally, and a probe disproved it: R2 answers an expired credential, a temporary credential past its `exp` included, with `403 SignatureDoesNotMatch`, the answer to a wrong secret. `adapter-s3` reads that as `InvalidCredentials` with `attempts: 1`, and the resolver is not called again with `forceRefresh: true` for it, so a resolver that hands out R2's temporary credentials renews them before their `exp`. `ExpiredRequest` stays mapped to `Expired`, which R2 sends for an expired presigned URL. No code changes (spec 7.2, 7.9, 14, ADR 0045).
