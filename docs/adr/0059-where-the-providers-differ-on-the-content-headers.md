# Where the providers differ on the content headers, the adapters repair it or the promise says so

ADR 0058 gave the content headers their shape in the core. This records how `adapter-s3`,
`adapter-azure-blob` and `adapter-gcs` hold that shape, from what AWS S3, R2, Azure Blob and the GCS
XML API were measured to do (`docs/research/content-headers-providers.md` on
`research/content-headers-providers`) and what the emulators do
(`docs/research/content-headers-emulators.md` on `research/content-headers-emulators`).

Most of the surface needs no decision. R2 neither drops nor refuses any of the three headers. Every
upload path carries them: S3 on `PutObject` and `CreateMultipartUpload`, GCS in the JSON resource
of `uploadType=multipart` and of the resumable start, Azure on `Put Blob` and `Put Block List`.
`get` learns them from the answer it already reads, `adapter-gcs` from the resource it fetches
beside the media download. And no provider narrows what the core lets through: Azure's ASCII, GCS's
100 characters of `Content-Language` and AWS's 2,048 bytes are the rule ADR 0058 checks before
signing.

None of the differences that remain is a withdrawal. No released package promises anything about
the content headers, so v0.6 states its promise for the first time, and writing it to what every
provider holds takes nothing from a caller. ADR 0017 governs the first narrowing after v0.6 ships.

Azure's `Put Blob From URL` keeps the three headers of the source but turns a stored
`Content-Language: de-AT, en` into `de-AT,en`; `Cache-Control: public, max-age=60, immutable` kept
its spaces. `copy` and `move` therefore keep `cacheControl` and `contentDisposition` byte for byte
and `contentLanguage` as the same list, whitespace around its commas possibly removed. That is the
promise of the parity core, not a line about one adapter, because the parity core promises what
every provider holds (ADR 0014). Repairing it would need the source's value before the copy: a
`HEAD` of the source, one request more, and a race in which a source replaced between that `HEAD`
and the copy pairs the new body with the old language. Whether Azure keeps the spaces of a
`x-ms-blob-content-language` sent on `Put Blob From URL` was not measured either. A capability
that `adapter-azure-blob` alone leaves undeclared would carry a whitespace difference through
`capabilityNames`, the conformance runs and every README.

`adapter-azure-blob`'s Shared Key signer folds every run of whitespace in an `x-ms-` header to one
space, and Azure hashes the value as sent: a `cacheControl` holding a tab or two spaces, which the
core lets through, would be refused with `403 AuthenticationFailed`. The signer trims each value
and folds nothing, which matched on the real account. Spec 8.4 sends a `userMetadata` value holding
a run of whitespace as encoded words so that no header value holds one, and that held as long as
user metadata was the only free text on a request; the content headers are sent as written.

The adapter sends the three as `x-ms-blob-cache-control`, `x-ms-blob-content-disposition` and
`x-ms-blob-content-language`, on `Put Blob` as on `Put Block List`. `Content-Disposition` has no
other form, `Put Block List` takes no other, and Azurite drops the standard `Cache-Control` and
`Content-Language` on `Put Blob` where Azure stores them. `Put Block List` clears what it does not
name, so it restates all three, as it restates `x-ms-blob-content-type` today. `Put Blob` keeps
sending the standard `Content-Type`.

Every refusal a provider was seen to give a content header already reaches `InvalidRequest`: AWS's
`MetadataTooLarge`, Azure's `InvalidMetadata`, GCS's `invalidArgument` and SeaweedFS's
`InvalidDigest`. None is reachable by a value inside the rule of ADR 0058, and neither are AWS's
`RequestHeaderSectionTooLarge` above 8 KB nor Azure's HTML `400` for a header of tens of kilobytes.
The code tables gain nothing.

The GCS JSON API is the one surface no measurement reached: the research ran against the XML API,
and the two document `Cache-Control` differently. That the JSON resource returns the three as sent,
a tab or a run of spaces included, after `uploadType=multipart`, a resumable upload, `rewriteTo`
without a body and `moveTo`, becomes a promise of spec section 18 that the first scheduled run
against the GCS bucket settles, as every addition no ticket observed does.

## Consequences

- The spec states in 4.11 that `copy` and `move` keep `contentLanguage` as a list whose whitespace
  around commas may be removed, and the conformance case compares it that way.
- Spec 8.4 replaces the reason for sending a whitespace run in `userMetadata` as encoded words, and
  says that Shared Key signs every `x-ms-` value trimmed and otherwise as sent.
  `x-ms-blob-content-type` on `Put Block List` and the three content headers are signed through
  that rule.
- Spec 8.6 names the three `x-ms-blob-*` headers on `Put Blob` and `Put Block List`.
- `capabilityNames` gains no name from the three cloud adapters. Whether `adapter-fs` or
  `adapter-memory` needs one is decided for those two on their own.
- Spec section 18 gains one promise for `adapter-gcs`, worded as above. A run that disproves it is
  withdrawn in a minor release.
- A value of 16 KiB or more that another tool stored fails Node's `fetch` on the way back with
  `HeadersOverflowError`. That is a limit of the runtime, which holds for any header, and v0.6 does
  not address it.
