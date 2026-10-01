---
"@stowage/core": minor
"@stowage/adapter-gcs": minor
---

An object another tool stored with a content coding may arrive decoded and longer than `size`, or as stored, depending on the runtime and the adapter. Spec 4.4 gave `fetch` decoding every content coding as the reason, which does not hold on Deno: under the `accept-encoding: identity` of `adapter-s3` and `adapter-azure-blob` it decodes no coding, and on `adapter-gcs` it decodes `gzip` and `br` and passes any other coding through. No code changes, and a range on such an object stays `ProviderError` on `adapter-gcs` (spec 4.4, 9.2, ADR 0044).
