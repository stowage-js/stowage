---
"@stowage/adapter-azure-blob": minor
---

The spec states what `adapter-azure-blob` already did in v0.3: every request asks for the bytes as the provider stores them, `Accept-Encoding: identity`, as `adapter-s3` does (spec 7.4, 8.4, ADR 0044).
