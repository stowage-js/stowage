# @stowage/adapter-azure-blob

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
