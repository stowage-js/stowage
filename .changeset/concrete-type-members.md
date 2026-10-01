---
"@stowage/core": minor
---

Nothing lies below an adapter's concrete type: a storage exposes no request, signer, credential or request hook, and `@stowage/core` exports no adapter-specific request, signer or credential. A caller who needs to send a request that stowage does not send signs it with code of their own, such as aws4fetch using the same access key (spec 4.1). A member added to a concrete type an adapter's factory returns, such as `S3Storage`, is a minor release before and after 1.0, as a name added to `StorageErrorCode` or `capabilityNames` is. A test double for code that stays portable is typed as `Storage`, removing or narrowing a member stays breaking, and `Storage` and `ConformanceTarget` are not concrete types in this sense. Below 1.0 a new member is a minor either way, so this takes nothing from a caller. 1.0 no longer waits for a shape of the `raw` escape hatch, and section 14 now lists no promise (spec 11, 13, 14, ADR 0042, ADR 0045).
