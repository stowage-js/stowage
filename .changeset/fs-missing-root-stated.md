---
"@stowage/adapter-fs": minor
---

The spec states what `adapter-fs` already did in v0.3: an operation against a root that does not exist rejects with `NotFound` without `key`, the shape every adapter now gives a missing bucket, so a wrong root never reads as an absent object (spec 4.10, 6, ADR 0043).
