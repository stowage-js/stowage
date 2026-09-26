# @stowage/adapter-memory

## 0.2.0

### Minor Changes

- 42a6ad3: **Breaking:**

  - `userMetadata` narrows to user metadata keys that are ASCII identifiers, `[A-Za-z_][A-Za-z0-9_]*`. The new capability `userMetadataTokenKeys` promises what `userMetadata` promised in v0.1: a key may be any ASCII HTTP token, such as `content-hash`. `adapter-memory` and `adapter-s3` declare both names and lose nothing. A third-party adapter that stores keys beyond identifiers declares `userMetadataTokenKeys` to keep passing the metadata case, which the conformance suite now splits into `put/user-metadata` and `put/user-metadata-token-keys` (ADR 0020).
  - `adapter-memory` measures the 2 KB of user metadata as the encoding of spec 4.13 writes it, as `adapter-s3` already did. A value with a space at either end or holding `=?` now counts as the encoded words it travels in, so a set just below 2 KB as written can be refused with `InvalidRequest` where v0.1 took it.
  - `delete` promises batches with one request each and no longer a number: each adapter states its own batch size (ADR 0020). `adapter-s3` sends at most one `DeleteObjects` per 1000 keys, as before, plus at most one `DELETE` per key holding `U+FFFE` or `U+FFFF`, which XML carries neither raw nor as a reference. 1000 such keys now cost 1000 requests where v0.1 promised one (ADR 0027).
  - `S3Storage.presignPut` resolves with a `PresignedPut` of `@stowage/core`, `{ url, headers }`, where v0.1 resolved with the URL alone. The upload sends `PUT` with `headers` beside the body; on `adapter-s3` they hold `content-type`, and never `Content-Length`, which the runtime writes from the body. The conformance cases of `presignPut` upload with the headers they get back, so a third-party adapter declaring `presignedUrls` resolves with a `PresignedPut` to keep passing them (ADR 0022).

### Patch Changes

- Updated dependencies [42a6ad3]
  - @stowage/core@0.2.0

## 0.1.0

### Minor Changes

- a4dcc3d: The first release: the parity core, the memory, file system and S3 adapters, and the conformance suite, as `docs/spec.md` states them.

### Patch Changes

- Updated dependencies [a4dcc3d]
  - @stowage/core@0.1.0
