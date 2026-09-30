---
"@stowage/core": minor
---

The spec states two promises the core already kept. `userMetadata` holding two keys that differ in case alone is `InvalidRequest` before anything is sent, as `checkUserMetadata` refused them in v0.2, since folding them into one would drop a value (spec 4.3). `maxParts` of `uploadStream` may be `Infinity` for a provider without a limit on the parts of one upload, which never refuses a stream, as `adapter-gcs` passes it (spec 4.13).
