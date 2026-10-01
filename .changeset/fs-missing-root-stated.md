---
"@stowage/adapter-fs": minor
---

The spec states what `adapter-fs` already did in v0.3: an operation against a root that does not exist rejects with `NotFound` without `key`, the shape providers use when they distinctly report a missing bucket. An inaccessible root may instead return `AccessDenied`. A wrong root must never read as an absent object (spec 4.10, 6, ADR 0043).
