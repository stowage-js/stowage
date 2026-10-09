# @stowage/conformance

## 0.6.0

### Minor Changes

- 966aa6c: The suite gains `put/content-headers`, `put/content-headers-multipart`, `put/content-headers-refused`, `copy/content-headers` and `move/content-headers`, each requiring `contentHeaders`. A storage declaring it keeps `cacheControl`, `contentDisposition` and `contentLanguage` byte for byte, and through `copy` and `move` a `contentType` with a parameter too, refuses what the checks of spec 4.3 refuse and keeps what meets their bounds exactly; a storage without it refuses any of the three as `Unsupported` naming `contentHeaders`, `""` included, and reports none. Every description these cases read carries no `contentEncoding`. A third-party adapter that refuses the three as unknown options fails the cases until it handles them (ADR 0058, ADR 0060, ADR 0064, ADR 0068).
- 7aaa81f: The suite gains `presign/put-content-headers` (`fast`) and `presign/put-rejects-content-headers` (`slow`), each requiring `presignedUrls` and `contentHeaders`. The first signs `cacheControl`, `contentDisposition` and `contentLanguage`, uploads with the returned `headers` and has `stat` report the three byte for byte and no `contentEncoding`; the second has an upload sending one of them with another value, and one leaving it out, each answer `4xx`. A storage declaring `presignedUrls` without `contentHeaders` refuses a `presignPut` carrying any of the three as `Unsupported` naming `contentHeaders`, with `attempts: 0`, and signs one carrying none. A third-party adapter declaring both that refuses the three as unknown options fails the cases until it handles them (spec 14.5, ADR 0063, ADR 0064).
- 4d46b94: The HTTP suite gains `serve/content-language`, `serve/stored-disposition` and `serve/stored-cache-control`, each requiring `contentHeaders` and seeding its object through `put`. A stored `de-AT` is answered as `Content-Language` to `GET`, to `HEAD` and on a `304`; a stored `attachment; filename="stored.pdf"` is answered as stored, and a stored `inline; filename="x.html"` as `attachment` with the key's last segment; a stored `public, max-age=60` leaves the `serve` route's `private, no-cache` as it is. Without `contentHeaders`, an object written without the three is answered without `Content-Language` and with the defaults (spec 14.9, ADR 0064).
- bf62a4c: **Breaking:** `serve/whole` and `serve/head` assert `Content-Length` equal to the size, where v0.5 asserted none. A server that drops the length of a `200` or of its `HEAD` fails them now: a third-party server on `workerd`, which sends every stream body chunked, or one on `Bun.serve` whose body still streams when the headers go out, passed them before and has no list of server alterations to undo the change with. This asserts more of a target than v0.5 did, a conflict with ADR 0017 (spec 14.9, ADR 0064).
- 0598cdd: The suite gains `errors/stale-credentials`, which runs where a target supplies the new optional factory `createStorageWithStaleCredentials(onRefresh)`: a storage whose resolver answers a credential the provider refuses until it is asked with `forceRefresh: true`, a fresh one from then on, and calls `onRefresh` on each refresh. `get`, `stat` and `put`, each on a storage of its own, succeed after at least one refresh, and the same operation repeated on the recovered storage asks for no further one (spec 14.5, ADR 0067).
- b8f641f: **Breaking:** `errors/bad-credentials` asserts that `stat` rejects with `InvalidCredentials`, `retryable: false` and `attempts` of `1` or `2`, as `get` does, and `errors/expired-credentials` that `stat` rejects with `Expired` and `attempts: 2`. An adapter that reads a refused `HEAD` by its status alone and reports `AccessDenied` no longer passes them (spec 14.5, ADR 0066).
- 5ddc2c3: The HTTP conformance case `upload/max-size` accepts, for its `PUT` of 1048577 bytes with a `Content-Length`, a `413` or a `fetch` rejected as a network error, since a client still writing past a refusal may meet a reset connection (spec 10.2, ADR 0056). It still requires the `413` for the same bytes sent as a stream, and asserts the stored object unchanged after both (spec 14.9). A server that passed the case still passes it.

### Patch Changes

- 48dc3c0: A case that reads back the bytes it wrote compares them without building a failure message for every byte. The comparison of the 17 MiB of `put/multipart-round-trip` takes some 30 ms instead of half a second, and a failure still names the first byte that differs.
- 5ddc2c3: An HTTP upload case whose `fetch` rejects as a network error now fails with an error naming the request, such as "`PUT` of a stream of 1048577 bytes without a length fails as a network error", and carries the rejection as its `cause`. Before, the case failed with `fetch`'s own `TypeError`, which does not say which request it belongs to (#346).
- Updated dependencies [bbe946a]
- Updated dependencies [966aa6c]
- Updated dependencies [cc305a2]
  - @stowage/core@0.6.0

## 0.5.0

### Minor Changes

- dce8b6a: The HTTP conformance suite: `describeHttpConformance(target, framework)` runs `httpConformanceCases` against a server through an `HttpConformanceTarget`, inside a `describe` named `<name> over HTTP`, with the run of spec 14.2 (spec 14.8, ADR 0050). `HttpConformanceContext` and `HttpConformanceCase` are exported beside it. Its 34 cases, each `fast`, serve a whole object, one range of it and the preconditions, redirect to a presigned URL, accept an upload and presign one: `serve/whole`, `serve/headers`, `serve/disposition`, `serve/head`, `serve/not-found`, `serve/method-not-allowed`, `serve/range`, `serve/suffix-range`, `serve/unsatisfiable-range`, `serve/ignored-range`, `serve/if-none-match`, `serve/if-modified-since`, `serve/if-match`, `serve/if-unmodified-since`, `serve/if-range`, `redirect/found`, `redirect/head`, `redirect/method-not-allowed`, `upload/stores`, `upload/streamed-body`, `upload/content-type-default`, `upload/empty-body`, `upload/overwrites`, `upload/max-size`, `upload/content-encoding`, `upload/method-not-allowed`, `upload/invalid-key`, `upload/no-header-metadata`, `presign/put`, `presign/method-not-allowed`, `presign/too-large`, `presign/invalid-length`, `presign/invalid-content-type` and `presign/invalid-key` (spec 14.9). The HTTP conformance suite is versioned as the conformance suite is: a new case is a minor, a new required member on `HttpConformanceTarget` is breaking, and so is a new value of the `answer` that `url` addresses. `HttpConformanceTarget` is not a concrete type in the sense of ADR 0042 (spec 15).

### Patch Changes

- @stowage/core@0.5.0

## 0.4.0

### Minor Changes

- d1d6cab: `ConformanceTarget` gains the optional factory `createStorageWithMissingBucket()`, which returns a storage bound to a bucket, container or root that does not exist and is otherwise configured as the one `createStorage()` returns. A target that leaves it out keeps passing. The new `fast` case `errors/missing-bucket` runs against it: `put`, `get`, `stat`, `exists`, `delete` and the first page of `list` each reject, so an `exists` that answers `false` and a `delete` that returns a report fail the case, and wherever the code is `NotFound`, `key` is unset (spec 4.10, ADR 0043). A target without the factory reports the case `skipped`.

### Patch Changes

- Updated dependencies [3daefb2]
- Updated dependencies [3daefb2]
- Updated dependencies [e506599]
  - @stowage/core@0.4.0

## 0.3.0

### Patch Changes

- eb8ba80: `presign/expired-url` accepts `400` or `403` for the expired URL, as spec 10.5 states, where it required `403`. GCS answers an expired V4 presigned URL with `400 ExpiredToken`, where S3, R2 and Azure answer `403` (spec 9.9). The case also signs a URL with `expiresIn: 60` beside the expired one and requires it to answer `200` after the same wait, so that a URL broken for another reason fails rather than passing as expired (ADR 0035).
- Updated dependencies [2a91517]
- Updated dependencies [40fc422]
- Updated dependencies [40fc422]
  - @stowage/core@0.3.0

## 0.2.0

### Minor Changes

- cf5bbbb: Add the conformance case `put/concurrent-writers`. Two streamed `put`s of 17 MiB write to one key, paced through their source streams so that each has read every byte and started every full part before either completes. Each may resolve or reject, at least one resolves, and the key holds one writer's object whole (spec 4.11, ADR 0024).
- 42a6ad3: **Breaking:**

  - `userMetadata` narrows to user metadata keys that are ASCII identifiers, `[A-Za-z_][A-Za-z0-9_]*`. The new capability `userMetadataTokenKeys` promises what `userMetadata` promised in v0.1: a key may be any ASCII HTTP token, such as `content-hash`. `adapter-memory` and `adapter-s3` declare both names and lose nothing. A third-party adapter that stores keys beyond identifiers declares `userMetadataTokenKeys` to keep passing the metadata case, which the conformance suite now splits into `put/user-metadata` and `put/user-metadata-token-keys` (ADR 0020).
  - `adapter-memory` measures the 2 KB of user metadata as the encoding of spec 4.13 writes it, as `adapter-s3` already did. A value with a space at either end or holding `=?` now counts as the encoded words it travels in, so a set just below 2 KB as written can be refused with `InvalidRequest` where v0.1 took it.
  - `delete` promises batches with one request each and no longer a number: each adapter states its own batch size (ADR 0020). `adapter-s3` sends at most one `DeleteObjects` per 1000 keys, as before, plus at most one `DELETE` per key holding `U+FFFE` or `U+FFFF`, which XML carries neither raw nor as a reference. 1000 such keys now cost 1000 requests where v0.1 promised one (ADR 0027).
  - `S3Storage.presignPut` resolves with a `PresignedPut` of `@stowage/core`, `{ url, headers }`, where v0.1 resolved with the URL alone. The upload sends `PUT` with `headers` beside the body; on `adapter-s3` they hold `content-type`, and never `Content-Length`, which the runtime writes from the body. The conformance cases of `presignPut` upload with the headers they get back, so a third-party adapter declaring `presignedUrls` resolves with a `PresignedPut` to keep passing them (ADR 0022).
  - `adapter-fs` reports a name the file system refuses to create as `InvalidKey`, through the `EILSEQ` it now maps: `InvalidKey` on write, `NotFound` on read. APFS refuses every noncharacter, so on macOS `put` and the `to` of `copy` and `move` refuse a key holding `U+FFFE`, which spec 4.8 lets a writable key hold and which v0.1 promised on macOS. That write never succeeded there and was reported as `ProviderError`; the promise is withdrawn all the same. Linux holds such keys as before. A `move` names the destination key in that error, where it named the source (#161).
  - A key or a user metadata value holding a lone surrogate is now refused, where `adapter-memory` and `adapter-fs` used to accept it. A lone surrogate is no Unicode character and has no UTF-8 form, so `adapter-fs` stored such a key with `U+FFFD` in its place and `adapter-s3` failed with a `URIError`. `invalidKeyReason` refuses it as `InvalidKey` under `writable`, `addressable` and `prefix`, and `checkUserMetadata` refuses such a value with `InvalidRequest` before it measures the 2 KB (spec 4.3, 4.8, ADR 0010). The conformance suite adds a key holding a lone high and a lone low surrogate to `put/refused-keys`, such a value to `put/user-metadata-limits`, and the case `get/refused-keys`, which asserts the refused addressable list of spec 9.7 against `get`, `stat` and `exists` (#189).

### Patch Changes

- b488681: `errors/bad-credentials` accepts `InvalidCredentials` with `attempts` of `1` or `2`, as spec 9.5 states, where it required `1`. An adapter that refreshes a refused access token once, as `adapter-azure-blob` does, spends a second attempt before it gives up (ADR 0021).
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
