---
"@stowage/core": minor
"@stowage/adapter-gcs": patch
---

`@stowage/core` exports `contentCodingRefusal(contentEncoding, key)`, the one definition of the rule of spec 4.3 that an object another tool stored with a content coding takes no range. It returns `ProviderError` naming the coding and the key, or `undefined` for an absent value, an empty value and `identity` in any case (spec 4.13, ADR 0044). `@stowage/adapter-gcs` refuses such a range through it instead of its own copy; it still reads the coding off the resource's `contentEncoding` or the download's `x-goog-stored-content-encoding`, and the error and its message are unchanged.
