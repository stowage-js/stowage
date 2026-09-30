---
"@stowage/core": minor
---

The spec states what the core already held without promising it. `userMetadata` holding two keys that differ in case alone is `InvalidRequest` before anything is sent, as `checkUserMetadata` refused them in v0.2, since folding them into one would drop a value (spec 4.3). `maxParts` of `uploadStream` may be `Infinity` for a provider without a limit on the parts of one upload, and a limit of `Infinity` never refuses a stream, as `adapter-gcs` passes it (spec 4.13). `size` counts the bytes the storage holds: on GCS, an object another tool stored with a content coding may arrive decoded and longer than `size`, and `adapter-gcs` never writes a content coding (spec 4.4, ADR 0040).
