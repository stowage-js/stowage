# @stowage/adapter-azure-blob

## 0.4.0

### Minor Changes

- 3daefb2: The spec states what `adapter-azure-blob` already did in v0.3: every request asks for the bytes as the provider stores them, `Accept-Encoding: identity`, as `adapter-s3` does (spec 7.4, 8.4, ADR 0044).
- 3daefb2: **Breaking:** `adapter-s3` and `adapter-azure-blob` no longer answer a missing bucket like a missing object. `exists` in a bucket AWS names as missing, or in a missing container, answered `false`, the `NotFound` of every operation named the key, and `adapter-azure-blob` reported one `failed` entry per key from `delete`, so a wrong bucket name read as an absent object. Now S3's `NoSuchBucket` and Azure's `ContainerNotFound` are `NotFound` without `key` on every operation, `delete` and `deleteAll` included, and `exists` answers `false` for a `NotFound` carrying `key` alone and rethrows every other failure. On `adapter-s3` a `HEAD` cannot tell the two apart, so a `404` to the `HEAD` of `stat` or `exists` is followed by one `GET` of the same key with `Range: bytes=0-0`: an absent key costs two requests, and one that exists still costs one. Only a body naming `NoSuchBucket` changes the answer, and a `GET` that receives no response rejects with `NetworkError`. On R2 under a token scoped to other buckets, a missing bucket stays `AccessDenied`. On `adapter-azure-blob` a Blob Batch whose subresponses name `ContainerNotFound` rejects the whole `delete`, and `deleteAll` with it, with that `NotFound`; a subresponse answered `404 BlobNotFound` still counts as deleted. This narrows what spec 4.10 promised for two released adapters, a conflict with ADR 0017, under which taking a promise out of the spec takes it from the caller whether or not a line of code moves (spec 4.10, 7.2, 7.9, 8.4, 8.8, ADR 0043).

  **Breaking:** `adapter-s3` and `adapter-azure-blob` no longer read a range of an object another tool stored with a content coding. Such a range read a truncated prefix on Node where it started at zero and a broken body where it started later, a broken body on Bun and `workerd`, and the stored bytes on Deno. Where the answer to a ranged `get` names a `Content-Encoding` other than `identity`, the body is canceled and `get` rejects with `ProviderError` naming the coding, also where the range covers the whole object, as on `adapter-gcs`. A start at or beyond the stored size stays `InvalidRequest`, since the `416` names no coding. A `get` without `range` still reads what `fetch` hands over, which may be longer than `size`, the stored size. `rangeReads` stays declared, since every object stowage writes honors a range. This narrows what spec 4.3 promised for two released adapters, that `range` is honored wherever `rangeReads` is declared, a conflict with ADR 0017, under which taking a promise out of the spec takes it from the caller whether or not a line of code moves (spec 4.3, 4.4, 7.2, 8.2, ADR 0044).

  **Breaking:** `adapter-s3` no longer promises `Expired` for an expired credential on R2, nor the repeat with `forceRefresh: true` that follows `Expired`. Spec 7.9 mapped R2's `ExpiredRequest` to `Expired` provisionally, and a probe disproved it: R2 answers an expired credential, a temporary credential past its `exp` included, with `403 SignatureDoesNotMatch`, the answer to a wrong secret. `adapter-s3` reads that as `InvalidCredentials` with `attempts: 1`, and the resolver is not called again with `forceRefresh: true` for it, so a resolver that hands out R2's temporary credentials renews them before their `exp`. `ExpiredRequest` stays mapped to `Expired`, which R2 sends for an expired presigned URL. No code changes, and the promise is withdrawn all the same: this narrows what spec 7.9 promised for a released adapter, a conflict with ADR 0017, under which taking a promise out of the spec takes it from the caller whether or not a line of code moves (spec 7.2, 7.9, 14, ADR 0045).

### Patch Changes

- Updated dependencies [3daefb2]
- Updated dependencies [3daefb2]
- Updated dependencies [e506599]
  - @stowage/core@0.4.0

## 0.3.0

### Patch Changes

- 2a91517: `@stowage/core` exports the `multipart/mixed` batch that Blob Batch on Azure and the batch endpoint of the GCS JSON API share: `batchBoundary`, `batchContentType`, `batchBody`, which writes each subrequest as an `application/http` part numbered by its place, and `readSubresponses`, which reads the answer's subresponses and pairs each to its subrequest by the `Content-ID` form the adapter names. An answer it cannot read comes back as `unreadable` or `unanswered`, which the adapter raises as `ProviderError` (spec 4.13). `adapter-azure-blob` sends and reads its Blob Batch through them and no longer holds a copy; its behavior does not change.
- Updated dependencies [2a91517]
- Updated dependencies [40fc422]
- Updated dependencies [40fc422]
  - @stowage/core@0.3.0

## 0.2.0

### Minor Changes

- 34b5fed: Add `@stowage/adapter-azure-blob`, a storage in one container of an Azure Blob Storage account. `azureBlobStorage` validates its configuration at construction and resolves the credential before every request: an account key signs with Shared Key, and an Entra ID access token travels as a bearer. `put` of held bytes and `get` reach the service (spec 8, ADR 0019, ADR 0021).
- 1749b13: `adapter-azure-blob` declares `keyBytesPreserved`. The first scheduled run against the account stored, listed and read an NFC and an NFD name as two blobs, so a key comes back byte for byte as it was written. The conformance case `list/key-bytes` now holds the adapter to that (spec 8.1, ADR 0020).

### Patch Changes

- Updated dependencies [faed69a]
- Updated dependencies [f7d1413]
- Updated dependencies [42a6ad3]
  - @stowage/core@0.2.0
