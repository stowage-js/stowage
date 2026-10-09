---
"@stowage/adapter-azure-blob": patch
---

`copy` and `move` keep the source's `contentType` and stored content coding byte for byte. Up to v0.5, `Put Blob From URL` rewrote both when it copied them itself: `text/plain;charset=utf-8` arrived as `text/plain; charset=utf-8`, and `gzip, br` as `gzip,br`. `copy` now reads the source with a `HEAD`, which costs one request more. It restates both properties and the content headers on a copy pinned to the source's entity tag through `x-ms-source-if-match`. A source replaced between the two requests is read and copied again, three times at most. After that the copy rejects with a `ProviderError` that is `retryable`, its `attempts` counting every copy sent (ADR 0068).
