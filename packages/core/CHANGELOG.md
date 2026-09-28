# @stowage/core

## 0.2.0

### Minor Changes

- faed69a: Add the range rules and the user metadata checks of spec 4.3 for adapter authors: `rangeBoundsRefusal`, `rangeStartRefusal`, `lastByteOf`, `rangeCoversWhole`, `rangeHeader`, `wholeSizeOf` and `checkUserMetadata`. Each answers with a `Refusal`, the code, message and capability of the failure, and leaves raising the `StorageError` to the adapter (spec 4.13, ADR 0019).
- f7d1413: `@stowage/core` exports `uploadStream`, the one definition of reading a streamed body into parts of `partSize` and sending them with `concurrency` in flight. An adapter passes `whole` for a stream that ends within the first part and `multipart` to start, send through `sendParts` and commit. The core checks the adapter's `maxParts` and keeps the part reader, the buffers and the cancellation of the source to itself (spec 4.13, ADR 0030). `adapter-s3` and `adapter-azure-blob` upload streams through it and no longer hold a copy each.
- 42a6ad3: **Breaking:**

  - `userMetadata` narrows to user metadata keys that are ASCII identifiers, `[A-Za-z_][A-Za-z0-9_]*`. The new capability `userMetadataTokenKeys` promises what `userMetadata` promised in v0.1: a key may be any ASCII HTTP token, such as `content-hash`. `adapter-memory` and `adapter-s3` declare both names and lose nothing. A third-party adapter that stores keys beyond identifiers declares `userMetadataTokenKeys` to keep passing the metadata case, which the conformance suite now splits into `put/user-metadata` and `put/user-metadata-token-keys` (ADR 0020).
  - `adapter-memory` measures the 2 KB of user metadata as the encoding of spec 4.13 writes it, as `adapter-s3` already did. A value with a space at either end or holding `=?` now counts as the encoded words it travels in, so a set just below 2 KB as written can be refused with `InvalidRequest` where v0.1 took it.
  - `delete` promises batches with one request each and no longer a number: each adapter states its own batch size (ADR 0020). `adapter-s3` sends at most one `DeleteObjects` per 1000 keys, as before, plus at most one `DELETE` per key holding `U+FFFE` or `U+FFFF`, which XML carries neither raw nor as a reference. 1000 such keys now cost 1000 requests where v0.1 promised one (ADR 0027).
  - `S3Storage.presignPut` resolves with a `PresignedPut` of `@stowage/core`, `{ url, headers }`, where v0.1 resolved with the URL alone. The upload sends `PUT` with `headers` beside the body; on `adapter-s3` they hold `content-type`, and never `Content-Length`, which the runtime writes from the body. The conformance cases of `presignPut` upload with the headers they get back, so a third-party adapter declaring `presignedUrls` resolves with a `PresignedPut` to keep passing them (ADR 0022).
  - `adapter-fs` reports a name the file system refuses to create as `InvalidKey`, through the `EILSEQ` it now maps: `InvalidKey` on write, `NotFound` on read. APFS refuses every noncharacter, so on macOS `put` and the `to` of `copy` and `move` refuse a key holding `U+FFFE`, which spec 4.8 lets a writable key hold and which v0.1 promised on macOS. That write never succeeded there and was reported as `ProviderError`; the promise is withdrawn all the same. Linux holds such keys as before. A `move` names the destination key in that error, where it named the source (#161).
  - A key or a user metadata value holding a lone surrogate is now refused, where `adapter-memory` and `adapter-fs` used to accept it. A lone surrogate is no Unicode character and has no UTF-8 form, so `adapter-fs` stored such a key with `U+FFFD` in its place and `adapter-s3` failed with a `URIError`. `invalidKeyReason` refuses it as `InvalidKey` under `writable`, `addressable` and `prefix`, and `checkUserMetadata` refuses such a value with `InvalidRequest` before it measures the 2 KB (spec 4.3, 4.8, ADR 0010). The conformance suite adds a key holding a lone high and a lone low surrogate to `put/refused-keys`, such a value to `put/user-metadata-limits`, and the case `get/refused-keys`, which asserts the refused addressable list of spec 9.7 against `get`, `stat` and `exists` (#189).

## 0.1.0

### Minor Changes

- a4dcc3d: The first release: the parity core, the memory, file system and S3 adapters, and the conformance suite, as `docs/spec.md` states them.
