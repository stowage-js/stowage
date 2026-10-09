# @stowage/adapter-azure-blob

## 0.6.0

### Minor Changes

- bbe946a: `stat`, `get`, `copy` and `move` report `contentEncoding`, the content coding a blob is stored with, from the `HEAD` or `GET` they already send, the `HEAD` of the destination for `copy` and `move`; `identity` and an empty value read as none. `put` reports none (ADR 0061).
- 6fe5349: `adapter-azure-blob` declares `contentHeaders`. `put` sends `cacheControl`, `contentDisposition` and `contentLanguage` as `x-ms-blob-cache-control`, `x-ms-blob-content-disposition` and `x-ms-blob-content-language` on `Put Blob` and on the `Put Block List` of a block upload, and `put`, `stat`, `get`, `copy` and `move` report them as stored; an empty stored value reads as none. `copy` and `move` keep all three byte for byte. A value the checks of spec 4.3 refuse is refused before anything is sent, with `attempts: 0`, where it was `Unsupported` before (ADR 0058, ADR 0059, ADR 0068).
- 73d7d85: **Breaking:** `presignPut` on `adapter-azure-blob` binds `x-ms-blob-content-type` as well. Its SAS carries `srh=content-type,content-length,x-ms-blob-type,x-ms-blob-content-type`, and `headers` gains `x-ms-blob-content-type`, the content type again. `Put Blob` stores an `x-ms-blob-content-type` in place of `Content-Type`, so a client outside a browser could store another type than the one the URL bound by sending one unsigned. A browser sends `headers` as they come, so its upload is preflighted with the new header: a deployed CORS rule must allow `x-ms-blob-content-type` beside `content-type` and `x-ms-blob-type`, or the browser refuses the upload. This narrows what flow 2 promised on `adapter-azure-blob`, a conflict with ADR 0017, under which taking a promise out of the spec takes it from the caller whether or not a line of code moves (spec 3, 8.9, ADR 0063).
- 7aaa81f: `presignPut` takes `cacheControl`, `contentDisposition` and `contentLanguage` as optional options. Each one given is checked as `put` checks it, the content type counted in the 2,048 bytes, before the user delegation key is requested, with `attempts: 0`; named in `srh` as `x-ms-blob-cache-control`, `x-ms-blob-content-disposition` or `x-ms-blob-content-language`, appended after `x-ms-blob-content-type` in that order; and returned in `headers` under that name, so the browser still sends `headers` as they come. `Put Blob` stores no standard `Content-Disposition` and lets an `x-ms-blob-*` header override the standard one, so the standard names would bind nothing. A content header left out is not bound: whoever holds the URL may send it, and Azure stores it. Where the options are used, the account's CORS rule has to allow the headers they bind. Azure refuses an upload whose value differs from the signed one or is missing (spec 8.9, ADR 0063).
- 7aaa81f: **Breaking:** the binding of `presignPut` is exact up to runs of spaces, the content type's included. SigV4 and GOOG4 collapse a run of spaces in a signed value before comparing, so a URL signed for `public, max-age=60` admits `public,  max-age=60`, and AWS, R2 and GCS store the two spaces as sent; the same holds for `Content-Type`. Flow 2 stated the binding as exact, which was never true of a value's whitespace. A client still reaches no other type, length, disposition, cache directive or language than the one signed. This narrows what flow 2 promised, a conflict with ADR 0017, and is withdrawn in a minor release as a measurement disproving a promise is (spec 3, 7.10, 8.9, 9.9, ADR 0063).

### Patch Changes

- 425227d: `copy` and `move` keep the source's `contentType` and stored content coding byte for byte. Up to v0.5, `Put Blob From URL` rewrote both when it copied them itself: `text/plain;charset=utf-8` arrived as `text/plain; charset=utf-8`, and `gzip, br` as `gzip,br`. `copy` now reads the source with a `HEAD`, which costs one request more. It restates both properties and the content headers on a copy pinned to the source's entity tag through `x-ms-source-if-match`. A source replaced between the two requests is read and copied again, three times at most. After that the copy rejects with a `ProviderError` that is `retryable`, its `attempts` counting every copy sent (ADR 0068).
- 891225f: `adapter-azure-blob` signs every `x-ms-` header value under Shared Key trimmed and otherwise as sent, a tab and a run of spaces included. It folded each run of whitespace to one space, which Azure refuses with `403 AuthenticationFailed`: a streamed `put` of more than one part whose `contentType` held two spaces failed under an account key (ADR 0059).
- Updated dependencies [bbe946a]
- Updated dependencies [966aa6c]
- Updated dependencies [cc305a2]
  - @stowage/core@0.6.0

## 0.5.0

### Patch Changes

- @stowage/core@0.5.0

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
