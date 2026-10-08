---
"@stowage/adapter-s3": minor
"@stowage/adapter-azure-blob": minor
"@stowage/adapter-gcs": minor
---

**Breaking:** the binding of `presignPut` is exact up to runs of spaces, the content type's included. SigV4 and GOOG4 collapse a run of spaces in a signed value before comparing, so a URL signed for `public, max-age=60` admits `public,  max-age=60`, and AWS, R2 and GCS store the two spaces as sent; the same holds for `Content-Type`. Flow 2 stated the binding as exact, which was never true of a value's whitespace. A client still reaches no other type, length, disposition, cache directive or language than the one signed. This narrows what flow 2 promised, a conflict with ADR 0017, and is withdrawn in a minor release as a measurement disproving a promise is (spec 3, 7.10, 8.9, 9.9, ADR 0063).
