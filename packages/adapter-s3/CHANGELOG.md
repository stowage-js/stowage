# @stowage/adapter-s3

## 0.4.0

### Minor Changes

- 3daefb2: **Breaking:** `adapter-s3` and `adapter-azure-blob` no longer answer a missing bucket like a missing object. `exists` in a bucket AWS names as missing, or in a missing container, answered `false`, the `NotFound` of every operation named the key, and `adapter-azure-blob` reported one `failed` entry per key from `delete`, so a wrong bucket name read as an absent object. Now S3's `NoSuchBucket` and Azure's `ContainerNotFound` are `NotFound` without `key` on every operation, `delete` and `deleteAll` included, and `exists` answers `false` for a `NotFound` carrying `key` alone and rethrows every other failure. On `adapter-s3` a `HEAD` cannot tell the two apart, so a `404` to the `HEAD` of `stat` or `exists` is followed by one `GET` of the same key with `Range: bytes=0-0`: an absent key costs two requests, and one that exists still costs one. Only a body naming `NoSuchBucket` changes the answer, and a `GET` that receives no response rejects with `NetworkError`. On R2 under a token scoped to other buckets, a missing bucket stays `AccessDenied`. On `adapter-azure-blob` a Blob Batch whose subresponses name `ContainerNotFound` rejects the whole `delete`, and `deleteAll` with it, with that `NotFound`; a subresponse answered `404 BlobNotFound` still counts as deleted. This narrows what spec 4.10 promised for two released adapters, a conflict with ADR 0017, under which taking a promise out of the spec takes it from the caller whether or not a line of code moves (spec 4.10, 7.2, 7.9, 8.4, 8.8, ADR 0043).

  **Breaking:** `adapter-s3` and `adapter-azure-blob` no longer read a range of an object another tool stored with a content coding. Such a range read a truncated prefix on Node where it started at zero and a broken body where it started later, a broken body on Bun and `workerd`, and the stored bytes on Deno. Where the answer to a ranged `get` names a `Content-Encoding` other than `identity`, the body is canceled and `get` rejects with `ProviderError` naming the coding, also where the range covers the whole object, as on `adapter-gcs`. A start at or beyond the stored size stays `InvalidRequest`, since the `416` names no coding. A `get` without `range` still reads what `fetch` hands over, which may be longer than `size`, the stored size. `rangeReads` stays declared, since every object stowage writes honors a range. This narrows what spec 4.3 promised for two released adapters, that `range` is honored wherever `rangeReads` is declared, a conflict with ADR 0017, under which taking a promise out of the spec takes it from the caller whether or not a line of code moves (spec 4.3, 4.4, 7.2, 8.2, ADR 0044).

  **Breaking:** `adapter-s3` no longer promises `Expired` for an expired credential on R2, nor the repeat with `forceRefresh: true` that follows `Expired`. Spec 7.9 mapped R2's `ExpiredRequest` to `Expired` provisionally, and a probe disproved it: R2 answers an expired credential, a temporary credential past its `exp` included, with `403 SignatureDoesNotMatch`, the answer to a wrong secret. `adapter-s3` reads that as `InvalidCredentials` with `attempts: 1`, and the resolver is not called again with `forceRefresh: true` for it, so a resolver that hands out R2's temporary credentials renews them before their `exp`. `ExpiredRequest` stays mapped to `Expired`, which R2 sends for an expired presigned URL. No code changes, and the promise is withdrawn all the same: this narrows what spec 7.9 promised for a released adapter, a conflict with ADR 0017, under which taking a promise out of the spec takes it from the caller whether or not a line of code moves (spec 7.2, 7.9, 14, ADR 0045).

### Patch Changes

- Updated dependencies [3daefb2]
- Updated dependencies [3daefb2]
- Updated dependencies [e506599]
  - @stowage/core@0.4.0

## 0.3.0

### Minor Changes

- db64da9: A completion the GCS XML API refuses with `404 NoSuchPart`, for a part the upload does not hold, is `InvalidRequest`, as AWS's and R2's `InvalidPart` is, where it was `NotFound`. The GCS XML API stays a compatible endpoint that is not promised: spec 7.9 admits its string because it names a condition a promised provider names otherwise and was observed there (ADR 0041).

### Patch Changes

- Updated dependencies [2a91517]
- Updated dependencies [40fc422]
- Updated dependencies [40fc422]
  - @stowage/core@0.3.0

## 0.2.0

### Minor Changes

- 42a6ad3: **Breaking:**

  - `userMetadata` narrows to user metadata keys that are ASCII identifiers, `[A-Za-z_][A-Za-z0-9_]*`. The new capability `userMetadataTokenKeys` promises what `userMetadata` promised in v0.1: a key may be any ASCII HTTP token, such as `content-hash`. `adapter-memory` and `adapter-s3` declare both names and lose nothing. A third-party adapter that stores keys beyond identifiers declares `userMetadataTokenKeys` to keep passing the metadata case, which the conformance suite now splits into `put/user-metadata` and `put/user-metadata-token-keys` (ADR 0020).
  - `adapter-memory` measures the 2 KB of user metadata as the encoding of spec 4.13 writes it, as `adapter-s3` already did. A value with a space at either end or holding `=?` now counts as the encoded words it travels in, so a set just below 2 KB as written can be refused with `InvalidRequest` where v0.1 took it.
  - `delete` promises batches with one request each and no longer a number: each adapter states its own batch size (ADR 0020). `adapter-s3` sends at most one `DeleteObjects` per 1000 keys, as before, plus at most one `DELETE` per key holding `U+FFFE` or `U+FFFF`, which XML carries neither raw nor as a reference. 1000 such keys now cost 1000 requests where v0.1 promised one (ADR 0027).
  - `S3Storage.presignPut` resolves with a `PresignedPut` of `@stowage/core`, `{ url, headers }`, where v0.1 resolved with the URL alone. The upload sends `PUT` with `headers` beside the body; on `adapter-s3` they hold `content-type`, and never `Content-Length`, which the runtime writes from the body. The conformance cases of `presignPut` upload with the headers they get back, so a third-party adapter declaring `presignedUrls` resolves with a `PresignedPut` to keep passing them (ADR 0022).
  - `adapter-fs` reports a name the file system refuses to create as `InvalidKey`, through the `EILSEQ` it now maps: `InvalidKey` on write, `NotFound` on read. APFS refuses every noncharacter, so on macOS `put` and the `to` of `copy` and `move` refuse a key holding `U+FFFE`, which spec 4.8 lets a writable key hold and which v0.1 promised on macOS. That write never succeeded there and was reported as `ProviderError`; the promise is withdrawn all the same. Linux holds such keys as before. A `move` names the destination key in that error, where it named the source (#161).
  - A key or a user metadata value holding a lone surrogate is now refused, where `adapter-memory` and `adapter-fs` used to accept it. A lone surrogate is no Unicode character and has no UTF-8 form, so `adapter-fs` stored such a key with `U+FFFD` in its place and `adapter-s3` failed with a `URIError`. `invalidKeyReason` refuses it as `InvalidKey` under `writable`, `addressable` and `prefix`, and `checkUserMetadata` refuses such a value with `InvalidRequest` before it measures the 2 KB (spec 4.3, 4.8, ADR 0010). The conformance suite adds a key holding a lone high and a lone low surrogate to `put/refused-keys`, such a value to `put/user-metadata-limits`, and the case `get/refused-keys`, which asserts the refused addressable list of spec 9.7 against `get`, `stat` and `exists` (#189).

### Patch Changes

- Updated dependencies [faed69a]
- Updated dependencies [f7d1413]
- Updated dependencies [42a6ad3]
  - @stowage/core@0.2.0

## 0.1.0

### Minor Changes

- a4dcc3d: The first release: the parity core, the memory, file system and S3 adapters, and the conformance suite, as `docs/spec.md` states them.

### Patch Changes

- Updated dependencies [a4dcc3d]
  - @stowage/core@0.1.0
