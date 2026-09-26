# @stowage/adapter-azure-blob

## 0.2.0

### Minor Changes

- 34b5fed: Add `@stowage/adapter-azure-blob`, a storage in one container of an Azure Blob Storage account. `azureBlobStorage` validates its configuration at construction and resolves the credential before every request: an account key signs with Shared Key, and an Entra ID access token travels as a bearer. `put` of held bytes and `get` reach the service (spec 8, ADR 0019, ADR 0021).

### Patch Changes

- Updated dependencies [42a6ad3]
  - @stowage/core@0.2.0
