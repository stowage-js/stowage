# @stowage/adapter-gcs

## 0.5.0

### Patch Changes

- @stowage/core@0.5.0

## 0.4.0

### Minor Changes

- 3daefb2: An object another tool stored with a content coding may arrive decoded and longer than `size`, or as stored, depending on the runtime and the adapter. Spec 4.4 gave `fetch` decoding every content coding as the reason, which does not hold on Deno: under the `accept-encoding: identity` of `adapter-s3` and `adapter-azure-blob` it decodes no coding, and on `adapter-gcs` it decodes `gzip` and `br` and passes any other coding through. No code changes, and a range on such an object stays `ProviderError` on `adapter-gcs` (spec 4.4, 9.2, ADR 0044).

### Patch Changes

- e506599: `@stowage/core` exports `contentCodingRefusal(contentEncoding, key)`, the one definition of the rule of spec 4.3 that an object another tool stored with a content coding takes no range. It returns `ProviderError` naming the coding and the key, or `undefined` for an absent value, an empty value and `identity` in any case (spec 4.13, ADR 0044). `@stowage/adapter-gcs` refuses such a range through it instead of its own copy; it still reads the coding off the resource's `contentEncoding` or the download's `x-goog-stored-content-encoding`, and the error and its message are unchanged.
- Updated dependencies [3daefb2]
- Updated dependencies [3daefb2]
- Updated dependencies [e506599]
  - @stowage/core@0.4.0

## 0.3.0

### Minor Changes

- 10cc86d: Add `@stowage/adapter-gcs`, a storage in one bucket of Google Cloud Storage on the JSON API. `gcsStorage` validates its configuration and its `signer` at construction and resolves the access token before every request that carries it, sending it as `Authorization: Bearer`. `put` of held bytes, and of a stream that ends within one part, goes as one `uploadType=multipart` request, `get` sends the resource request and the media download side by side, and `stat` and `exists` read the object's resource (spec 9, ADR 0031, ADR 0033). A failure is read from the JSON API's error document whatever its `Content-Type`, a `404` means absence only with the provider code `notFound` outside the media download, a missing bucket is `NotFound` without `key` and `exists` rethrows it, transient failures are repeated on the core's `withRetry`, and a token refused as `invalid_token` is resolved once more under `forceRefresh` (spec 9.3, 9.5, 9.8, ADR 0038). `list` walks a prefix through `objects.list`, with or without a delimiter, sends `maxResults` on every page and continues with the answer's `nextPageToken`, which its cursor carries under a tag of the adapter's own; a cursor of another storage is `InvalidOption` naming `cursor` before any request, and so is one the provider refuses as `invalid` (spec 4.6, 9.4, 9.8, ADR 0034). `put` stores `userMetadata` with its keys folded to lower case and its values as written, and `stat` and `get` hand it back as stored, RFC 2047 encoded words decoded; `get` sends a `range` to the media download, stands by a `200` only where the range covers the object, and reports a media `416` as the refusal for the size the resource named (spec 4.3, 9.4, 9.8, ADR 0032). Where a writer replaced the object between the two requests of `get`, it reads the resource again pinned to the generation the body carries, and where that generation is gone downloads the first resource's generation instead, so `stat` describes the bytes the body carries at the cost of at most two requests more; where both are gone, `get` is `NotFound` naming the key. Which generation is newer is never read from their numbers (spec 4.5, 9.4, 9.8, ADR 0040). An object another tool stored with a content coding is read decoded, its `size` the stored size, and every `range` on it is `ProviderError` naming the coding, whatever the range and the status the download answered (spec 4.4, 9.2, 9.4, ADR 0040). A storage built with a `signer` carries `presignGet` and `presignPut`, which return V4 signed URLs on the XML API, path-style on the configured endpoint, signed as the signer's service account with `GOOG4-RSA-SHA256`: locally with Web Crypto from a PKCS#8 PEM or a `CryptoKey`, or through one `signBlob` of the IAM Credentials API under the signer's own token, which is repeated and read like every other request; `presignPut` binds `content-length`, `content-type` and `host` (spec 9.9, ADR 0035). `delete` sends its keys to the batch endpoint of the JSON API, at most 100 deletes per request and one request at a time, reports an invalid key as `InvalidKey` in `failed` and deletes the others, counts a subresponse `404 notFound` as deleted, rejects the whole call with `NotFound` where the message names a missing bucket, and reports every other failed subresponse in `failed` with the outer answer's `requestId`; `deleteAll` walks the prefix a page of 1000 at a time and deletes each page as it arrives (spec 4.7, 9.1, 9.4, ADR 0032). `copy` sends `rewriteTo` and sends it again with each answer's `rewriteToken` until the rewrite is done, each call on a budget of its own and the caller's signal checked between two of them, and resolves with the object the finishing answer carries; a continued call answering `404` is `NotFound` naming the source, and the destination takes the bucket's default storage class. `move` sends one `objects.move`, which keeps the storage class, and a `404` after an attempt that received no response or a `5xx` rejects with that attempt's failure, since the move may have happened (spec 9.5, 9.7, ADR 0037). A stream that fills more than one part goes as one resumable session: a start carrying the resource under the credential, then the parts of `multipart.partSize`, 8 MiB by default, as chunks one after another at their offsets, the short last part or an empty chunk naming the total committing, and `put` resolves with the object the commit answers with. The acknowledged range of every `308` decides what goes next, the rest of a short acknowledgement without spending an attempt, and every request of the session is repeated as sent, its commit included. A failed or aborted upload cancels the source and the session under an independent 10-second timeout, and where the commit went unanswered the cancel's answer settles whether it committed. The chunks, the commit and the cancel carry no credential, the session URI appears in no error, and no request of the session reports a `requestId` (spec 9.6, 9.8, ADR 0036).

### Patch Changes

- Updated dependencies [2a91517]
- Updated dependencies [40fc422]
- Updated dependencies [40fc422]
  - @stowage/core@0.3.0
