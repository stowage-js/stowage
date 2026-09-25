---
"@stowage/core": minor
"@stowage/adapter-memory": minor
"@stowage/adapter-s3": minor
"@stowage/conformance": minor
---

**Breaking:**

- `userMetadata` narrows to user metadata keys that are ASCII identifiers, `[A-Za-z_][A-Za-z0-9_]*`. The new capability `userMetadataTokenKeys` promises what `userMetadata` promised in v0.1: a key may be any ASCII HTTP token, such as `content-hash`. `adapter-memory` and `adapter-s3` declare both names and lose nothing. A third-party adapter that stores keys beyond identifiers declares `userMetadataTokenKeys` to keep passing the metadata case, which the conformance suite now splits into `put/user-metadata` and `put/user-metadata-token-keys` (ADR 0020).
- `adapter-memory` measures the 2 KB of user metadata as the encoding of spec 4.13 writes it, as `adapter-s3` already did. A value with a space at either end or holding `=?` now counts as the encoded words it travels in, so a set just below 2 KB as written can be refused with `InvalidRequest` where v0.1 took it.
