---
"@stowage/conformance": patch
---

A case that reads back the bytes it wrote compares them without building a failure message for every byte. The comparison of the 17 MiB of `put/multipart-round-trip` takes some 30 ms instead of half a second, and a failure still names the first byte that differs.
