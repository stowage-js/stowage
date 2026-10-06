---
"@stowage/adapter-s3": patch
---

An abort that lands while `adapter-s3` reads the error document of a refused request now rejects with the runtime's `AbortError`, as spec 4.10 promises, rather than with a `StorageError` built from the status. `adapter-azure-blob` and `adapter-gcs` already did so.
