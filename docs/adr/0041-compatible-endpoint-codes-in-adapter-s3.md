# The S3 adapter reads a compatible endpoint's code without promising it

ADR 0014 gave `adapter-s3` one code table holding both vendors' strings, and ADR 0003 leaves every
other endpoint that speaks the S3 wire protocol configurable and unpromised. A code such an endpoint
sends and neither vendor does falls to the status mapping of spec 4.10, which can read it as the
opposite of what happened. The spike of ADR 0031 met one on 2026-09-28, against the measurement
bucket `stowage-gcs-measurement` on the GCS XML API with an HMAC key, on branch
`spike/gcs-xml-s3`: a `CompleteMultipartUpload` naming a part the upload does not hold, or an ETag
a second upload of the same part replaced, answers `404 NoSuchPart`, "The requested upload part was
not found." AWS and R2 answer the same completion `400 InvalidPart`. The adapter read the `404` as
`NotFound`, telling the caller that something is absent where the provider refused the request.

The table takes a compatible endpoint's string where four things hold. It collides with no string
of a promised provider. It names a condition that a promised provider names with another string,
and takes that string's error code, so one condition keeps one code for the caller to branch on,
as `EntityTooLarge` and `InvalidRequest` already share one for a copy above 5 GiB. It was observed
at a real endpoint and the observation is recorded here, since documentation that no request has
confirmed is how `ExpiredRequest` came to be marked provisional. And it does not come from an
emulator: an emulator stands in for a provider, and where it departs from one, the departure stays
a divergence against its conformance case rather than a table entry that turns the per-commit run
green on a path no promised provider takes. Such a string promises nothing about the endpoint that
sends it. No run repeats the observation, because a scheduled run against a compatible endpoint is
what spec 2 counts as support. `NoSuchPart` meets all four and reads as `InvalidRequest`, as
`InvalidPart` does.

Keeping the table to the two vendors was the alternative. It keeps ADR 0014's sentence true, and
leaves GCS through `adapter-s3` answering a refused completion with `NotFound`, although the entry
that repairs it needs no branch, no flag and no knowledge of the endpoint, which is all ADR 0014
rules out.

## Consequences

- Spec 7.9 says that the table holds the promised providers' strings and a compatible endpoint's
  string admitted by this rule, and carries `NoSuchPart` beside `InvalidPart`, noted as the GCS
  XML API's. Spec 7.2 names such an endpoint a compatible endpoint.
- ADR 0014's one table no longer holds the two vendors' strings alone. Its reasons stand: one
  table rather than one per provider, and no string that collides.
- The code decides over the status, so `NoSuchPart` at `404` is `InvalidRequest`, and it is not
  transient, as ADR 0013 reads a `404`.
- A caller rarely meets it. The adapter names every part itself and keeps the ETag of the attempt
  that succeeded, so the completion fails this way only where someone else replaced a part of the
  same upload or the endpoint lost one.
- The spike's other GCS answers need no entry: `ExpiredToken` and `InvalidObjectName` are in the
  table already, and `MalformedMultiObjectDeleteRequest` and `ExcessHeaderValues` answer requests
  the adapter never sends. No other compatible endpoint was searched for strings; the rule applies
  when an observation arrives.
- The spec 14 probe of `harness/s3` keeps asserting `providerCode: "InvalidPart"`. It runs against
  AWS and R2 alone, never against a compatible endpoint.
