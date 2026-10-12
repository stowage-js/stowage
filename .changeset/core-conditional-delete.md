---
"@stowage/core": minor
---

**Breaking:** `Storage` carries a second form of `delete`, `delete(key: string, options: DeleteOptions): Promise<DeleteReport>`, beside the variadic one, so an adapter written elsewhere that implements `delete` with the variadic signature alone is no longer assignable to `Storage` until it implements the form for one key (spec 15, ADR 0070).
