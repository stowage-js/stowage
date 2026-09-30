---
"@stowage/adapter-s3": minor
---

A completion the GCS XML API refuses with `404 NoSuchPart`, for a part the upload does not hold, is `InvalidRequest`, as AWS's and R2's `InvalidPart` is, where it was `NotFound`. The GCS XML API stays a compatible endpoint that is not promised: spec 7.9 admits its string because it names a condition a promised provider names otherwise and was observed there (ADR 0041).
