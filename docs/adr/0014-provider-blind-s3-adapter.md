# The S3 adapter does not know which of the two providers it is talking to

`@stowage/adapter-s3` takes no `provider` option and detects nothing. ADR 0003 promises AWS S3 and
Cloudflare R2 through one adapter, so where the two answer differently the adapter is written to
whichever side is stricter, and the parity core promises what both of them hold. A behavior only
one provider has leaves the parity core instead of entering it behind a flag. ADR 0009 decided
chunked signing that way and ADR 0011 decided POST policies that way; this states the rule for the
rest of the surface at once.

A flavor — `provider: "aws" | "r2"`, switching behavior and the declared capabilities with it —
was put against every difference below and won none of them. Each difference costs a line or two
written to the stricter side, against a flag that would run through signing, listing, uploading
and the error table, double what the conformance suite covers, and leave the endpoint of ADR 0012
as a third case nobody can name: SeaweedFS is neither provider, and a third value would promise a
behavior no run checks. An endpoint that is not named takes the strict path, which is the path
every commit already exercises. Detection was never open, because ADR 0003 makes region and
endpoint configuration and discovers nothing at runtime.

Four differences narrow a promise rather than the code. A listing has no order: S3 documents
lexicographical order by UTF-8 byte, R2 documents that for its Workers binding and nowhere for its
S3 endpoint, and it documents no ceiling for `max-keys` either. Unicode-equivalent keys may be one
object or two, because R2 normalizes a key to NFC before storing it, so `Héllo` written as NFC and
as NFD is one object there and two on S3. User metadata carries 2 KB, which is AWS's limit against
R2's 8192 bytes. And a body the adapter holds goes as one `PUT` up to 5 GB, which is AWS's limit
against R2's 5 GiB. The object ceiling is the one limit the adapter does not restate at all: AWS's
own pages carry 48.8 TiB and 50 TB, R2 carries 5 TiB footnoted as 4.995 TiB, and `EntityTooLarge`
answers with the same code and status on both.

The sharpest difference is in the failures. R2 has no `InvalidAccessKeyId` — a key it does not
know is `Unauthorized` at `401`, where AWS answers `InvalidAccessKeyId` at `403` — and documents
`ExpiredRequest` at `403` where AWS answers `ExpiredToken` at `400`. R2 `Expired` handling remains
unconfirmed, however: ADR 0012's conformance case skips R2, so this documented mapping must not be
treated as conformance evidence until it is observed against real R2. Throttling is
`TooManyRequests` at `429` against S3's `SlowDown` at `503`. Code and status differ in all three,
so neither half of the mapping ADR 0005 describes carries over on its own. Below that family the
two agree: `NoSuchKey`, `NoSuchBucket`,
`AccessDenied`, `SignatureDoesNotMatch`, `EntityTooSmall`, `EntityTooLarge`, `InvalidPart`,
`NoSuchUpload`, `PreconditionFailed`, `BadDigest`, `ServiceUnavailable` and `InternalError` carry
the same string and the same status on both, and R2's error document has the shape S3's has.

Two further differences are corrected inside the adapter rather than in a promise. R2 derives a
`Content-Type` from the body when the request carries none while S3 stores its own default, so the
adapter always sends one. And AWS documents that `CompleteMultipartUpload` can answer `200` with
an error document in the body, where R2 documents nothing either way — undocumented is not absent,
so the adapter reads that body on both.

One promise is left standing on one provider's documentation alone. The four response overrides
that `presignGet` carries are documented on `GetObject` by AWS, and the string `response-content`
appears nowhere in R2's, which is neither support nor refusal. They stay in v0.1 and the first run
of the `slow` tier against a real R2 bucket settles them, beside the points ADR 0012 already
leaves to a first run. The successful `GetObject` cases assert each override against its response
header: `responseContentType` equals `Content-Type`, `responseContentDisposition` equals
`Content-Disposition`, `responseCacheControl` equals `Cache-Control`, and `responseExpires` equals
`Expires`. An accepted but ignored override therefore fails its assertion.

## Consequences

- `S3Storage` has no `provider` option and no code path branches on the endpoint. An endpoint that
  is neither AWS nor R2 stays configurable and unpromised, which is what ADR 0003 already says.
- `list` yields every object below the prefix once across its pages, in no promised order. The
  conformance suite asserts membership rather than sequence, and a caller who needs order sorts a
  combined collection only after collecting every page; sorting pages independently cannot
  establish a global order. A page holds at most 1000 keys, and a larger page size is
  `InvalidOption`.
- A listing entry that arrives without a key, a size or a last-modified time is a `ProviderError`.
  AWS marks every field of its `Object` type except the key optional, and neither provider has
  been seen to omit one.
- Two keys that are Unicode-equivalent without being equal byte for byte may name one object or
  two. The two adapters that can show it say so in their README: `adapter-fs` returns NFD for a
  key written in NFC on APFS, and `adapter-s3` against R2 holds one object for both forms.
- `userMetadata` carries at most 2 KB across its keys and values, measured on the encoded header
  bytes that go on the wire, and the adapter refuses more with `InvalidRequest` before the request
  goes out, where ADR 0010 refuses a key. A metadata key outside ASCII is refused for the same
  reason: R2 strips it on the way out and counts it in `x-amz-missing-meta`, so writing it would
  lose it silently. Metadata values may hold any Unicode, which both providers carry RFC 2047
  encoded.
- A `Uint8Array` or string stays on the single-`PUT` path. To upload a body above the 5 GB
  single-`PUT` limit through multipart, the caller must instead provide a
  `ReadableStream<Uint8Array>`; the adapter does not convert held bytes into a stream implicitly.
  As ADR 0016 specifies, that stream becomes multipart only after it exceeds one part. ADR 0009
  carried both providers' numbers for the limit and for the object ceiling; the ceiling is the
  provider's answer rather than the adapter's check.
- `copy` above the size a single request carries reaches its fallback through the provider's
  refusal rather than through a ceiling the adapter knows, which is how it stays blind where AWS
  documents 5 GB and R2 documents nothing. Ranged `UploadPartCopy` would require every request to
  name one pinned source version so that concurrent replacement cannot mix versions. v0.1 excludes
  versioning, so the adapter refuses the fallback instead of relying on
  `x-amz-copy-source-if-match`; where R2 accepts `CopyObject` outright, no fallback is needed.
- `401` is `InvalidCredentials` in the status mapping of ADR 0005, because a `401` says the
  request was not authenticated at all. The three-way split of `403` that ADR 0005 argues for is
  observed on AWS through `InvalidAccessKeyId`, `ExpiredToken` and `AccessDenied`. R2 documents
  `Unauthorized`, `ExpiredRequest` and `AccessDenied`, but its `ExpiredRequest` branch remains
  unverified until the conformance case observes it against real R2.
- One code table holds both vendors' strings rather than one table per provider, which would need
  the flag this decision does not have. The strings do not collide. `Unauthorized` reaches
  `InvalidCredentials`, and `ExpiredRequest` is provisionally mapped to `Expired` pending a real
  R2 observation; `InvalidObjectName` reaches `InvalidKey`, and `TooManyRequests` and
  `ServiceUnavailable` reach `ProviderError`. ADR 0013 retries the last two by status either way;
  the table is what gives them a name the caller can read.
- `put` sends a `Content-Type` on every request and uses `application/octet-stream` where the
  caller named none, so what `stat` reports does not depend on which provider stored the object.
- `CompleteMultipartUpload` is not judged by its status line. The adapter parses the response
  body, which it reads for the ETag anyway, and an error document there fails the upload carrying
  the status that arrived. ADR 0013 keeps that request out of the retry group, so a body saying
  the commit failed ends the operation.
- The four response overrides on `presignGet` are provisional. `conformance-full.yml` settles them
  on its first run by comparing `responseContentType`, `responseContentDisposition`,
  `responseCacheControl` and `responseExpires` with `Content-Type`, `Content-Disposition`,
  `Cache-Control` and `Expires`, respectively.
- Reference flow 2 promises that a rejected upload reaches the client as an HTTP status, not that
  a browser can read the body. R2 sends no CORS headers on the `403` for an expired presigned URL,
  so page JavaScript sees a network error instead. The cases of ADR 0011 judge status and provider
  code from a runtime that is not a browser, and flow 2 already names the bucket's CORS
  configuration among its preconditions.
- A difference between AWS and R2 is not a divergence in the sense of ADR 0012. R2 stands in for
  nobody, so the difference is permanent and belongs in the spec; the harness list stays what it
  is, a record of where one emulator departs from the provider it imitates.
- No cell of the runtime matrix in ADR 0002 changes. A cell a provider cannot hold is promised for
  neither, and none of the differences found takes one away: each either narrows what is promised
  or is corrected inside the adapter.
- R2 aborts an incomplete multipart upload after seven days by default, which AWS leaves to a
  lifecycle rule. The remedy ADR 0005 names for parts left behind therefore has to be configured
  on the AWS bucket alone, and the CI buckets of ADR 0012 keep their rule on both, because one day
  is shorter.
- R2 accepts one write per second and key and answers `429` above it. ADR 0013 retries that three
  times under a five-second cap, which carries a single collision and not a loop writing the same
  key.
- A presigned URL works only against the endpoint that signed it, and on R2 that is
  `<ACCOUNT_ID>.r2.cloudflarestorage.com` rather than a custom domain. Reference flow 2 hands the
  browser the URL the adapter produced, so this constrains what `endpoint` may be set to rather
  than anything the caller does with the result.
- Conditional headers stay out of v0.1, and the gap is wider than ADR 0005 knew. AWS has
  conditional deletes through `If-Match`, `x-amz-if-match-last-modified-time` and
  `x-amz-if-match-size` and R2 has none; R2 takes `If-Modified-Since` and `If-Unmodified-Since` on
  `PutObject` where AWS takes only the two ETag forms; `If-Range` works on S3 and not on R2.
  Should a conditional surface arrive, the portable set is `If-Match` and `If-None-Match` on
  `GET`, `HEAD` and `PUT`, plus AWS's `409` answer as a retryable one.
- Storage classes, ACLs, tagging, object lock, versioning and server-managed encryption stay out
  beside the checksums ADR 0009 already ruled out. `x-amz-storage-class` is the only one of them
  R2 accepts, with two values against AWS's fifteen.
- The Cloudflare pages behind the differences above were read on 2026-09-20: S3 API compatibility,
  the error code table, presigned URLs, platform limits, object upload and Unicode
  interoperability. Each carries its own last-updated date, the oldest of them 2026-04-21.
