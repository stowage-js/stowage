---
"@stowage/adapter-azure-blob": minor
---

`adapter-azure-blob` declares `keyBytesPreserved`. The first scheduled run against the account stored, listed and read an NFC and an NFD name as two blobs, so a key comes back byte for byte as it was written. The conformance case `list/key-bytes` now holds the adapter to that (spec 8.1, ADR 0020).
