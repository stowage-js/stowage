# Where the providers differ on preconditions, adapter-s3 gives up the conditional delete

ADR 0070 gave preconditions their shape: `onlyIf` on `put` and on the destination of `copy` and
`move`, a one-key `delete` overload, the code `PreconditionFailed`, and the capabilities
`writeIfAbsent`, `writeIfUnchanged` and `deleteIfUnchanged`. This records which of them
`adapter-s3`, `adapter-azure-blob` and `adapter-gcs` declare and how each reads the provider's
answer (#441), from what AWS S3, R2, Azure Blob and the GCS JSON API were measured to do
(`docs/research/provider-preconditions.md` on `research/provider-preconditions`). When an upload
path checks the precondition, what a refused commit leaves behind and what a repeat after a lost
answer does stay with #443.

R2 drops `If-Match` on `DeleteObject` and the per-key `<ETag>` of `DeleteObjects` in silence and
deletes, with the answer a held precondition would give. `adapter-s3` does not know which provider
it talks to (ADR 0014), so it cannot send a conditional delete and know that the condition held.
It does not declare `deleteIfUnchanged`, and `delete(key, { onlyIf })` on it is `Unsupported`. AWS
holds the conditional delete, and its callers lose it with R2's. Declaring the capability with R2
named as a provider that loses it would drop a precondition in silence, which the map rules out;
an option the caller sets for AWS alone is the provider flag ADR 0014 refused.

R2 also ignores `If-None-Match` and `If-Match` on the destination of `CopyObject` and overwrites.
It holds its own `cf-copy-destination-if-none-match` and `cf-copy-destination-if-match`, which AWS
ignores. `adapter-s3` sends both sets on every conditional `CopyObject`, signed, and each provider
holds its own: measured on both, a failed destination precondition answered `412` with both sets
present. ADR 0070 binds `put` and the destination of `copy` and `move` into `writeIfAbsent` and
`writeIfUnchanged`, so leaving the copy out would cost `adapter-s3` the conditional `put` that both
providers hold, and a declared capability whose `copy` is `Unsupported` would break the rule that a
capability carries the whole call. `adapter-s3` declares both. Cloudflare marks the `cf-` headers
beta. Should R2 drop them, the conformance cases on the copy destination fail on the scheduled run,
and withdrawing the two capabilities from `adapter-s3` is a withdrawal under ADR 0017.

`adapter-azure-blob` declares all three. Azure holds both kinds on `Put Blob`, `Put Block List`,
the destination of `Put Blob From URL` and `Delete Blob`. A conditional `delete` is one
`Delete Blob`, not a Blob Batch of one subrequest, so its answer is read as the answer to that key.

`adapter-gcs` declares all three. It sends the precondition as `ifGenerationMatch`, `0` for
`"absent"` and the generation for `{ etag }`, on the `uploadType=multipart` insert, the start of a
resumable session, every call of `rewriteTo`, `objects.move`, and a conditional `delete`, which is
one `DELETE` and not a batch. Whether a later call of a rewrite that takes several needs the
precondition again was not measured, since a rewrite within one storage class finishes in one
call. Sending it on every call is the side that cannot drop it, and #448 measures it.

ADR 0070 makes a well-formed `etag` that cannot match `PreconditionFailed` without a request. On
`adapter-gcs` an `etag` is a generation when it is decimal digits without a leading zero, other
than `0`, and at most 2⁶³−1, the range of GCS's `int64`. `0` is left out because `ifGenerationMatch=0`
means that no object exists: `onlyIf: { etag: "0" }` would otherwise turn "unchanged" into
"absent" in silence.

A failed precondition becomes `PreconditionFailed` on each adapter, `status` and `providerCode`
carrying the provider's answer:

- `adapter-s3`: `PreconditionFailed` on every request. `ConditionalRequestConflict`, AWS's `409` for
  a multipart commit that a `PUT` landing after the upload began overtook, is `PreconditionFailed`
  too: the caller's way out is the same `stat` and decision as after a `412`, and a code of its own
  would carry one provider's ordering of multipart uploads into the API. AWS answers `If-Match`
  against a missing key with `404 NoSuchKey`, which on `PutObject` and `CompleteMultipartUpload`
  under `onlyIf: { etag }` is `PreconditionFailed`. `CopyObject` answers a missing source and a
  missing destination under `If-Match` with the same `404 NoSuchKey`, the same message and the same
  headers; only `<Key>` in the error document names which. Measured on 2026-10-11 against
  `stowage-js-conformance`: a missing source named the source (`QM5FF7VGNDT0QYAS`), a missing
  destination under `If-Match` named the destination (`QM57JG3Y4PZ168NE`), and with both missing
  AWS named the destination (`29PA6C4KEAGTHH0V`), so it checks the destination's precondition first.
  Under `onlyIf: { etag }`, a `NoSuchKey` whose `<Key>` is `to` is `PreconditionFailed`; any other,
  `<Key>` naming `from` or absent, stays the missing source it is today. A copy of a key onto
  itself is refused before any request (spec 7.8), so `<Key>` never names both.
- `adapter-azure-blob`: `BlobAlreadyExists` at `409`, Azure's answer to a failed `If-None-Match: *`
  where its documentation lists `412`, and `ConditionNotMet` at `412`. `CannotVerifyCopySource`
  stays the failed pin of the source and never becomes `PreconditionFailed`, which the codes keep
  apart. A conditional `delete` answered `404 BlobNotFound` is `PreconditionFailed` and not counted
  as deleted.
- `adapter-gcs`: `conditionNotMet` at `412`. A conditional `delete` answered `404 notFound` is
  `PreconditionFailed`, after the rule that tells a missing bucket by its message.

Where an adapter declares `writeIfUnchanged`, ADR 0070 promises `etag` on every `ObjectStat` and
`ObjectEntry`. An answer that feeds one and carries no `ETag`, or on `adapter-gcs` no `generation`,
is `ProviderError`, as ADR 0014 has it for a listing entry without a size. That covers the `ETag`
header of `PutObject` and `Put Blob`, the `ETag` in the body of `CompleteMultipartUpload`, the
`HEAD` that describes the destination of a copy, and every listing entry. No provider was seen to
leave one out.

None of this conflicts with ADR 0017. The three capabilities are new, so one that `adapter-s3` does
not declare takes nothing from a caller. `BlobAlreadyExists`, `ConditionNotMet` and
`conditionNotMet` were unreachable before, since no adapter sent a precondition, and the
`NoSuchKey` of a `CopyObject` without `onlyIf` reads as it did. Every request the adapters send with
a precondition was observed on its real endpoint, so spec section 18 gains nothing. Azure was
measured under Shared Key alone; the conditional headers do not depend on how a request
authenticates, and the conformance runs on `main` cover the access token.

## Consequences

- Spec 7 has `adapter-s3` declare `writeIfAbsent` and `writeIfUnchanged`, not `deleteIfUnchanged`,
  send both header sets on a conditional `CopyObject`, and read `<Key>` of a `NoSuchKey` on one.
  The table of 7.9 gains `PreconditionFailed` and `ConditionalRequestConflict`.
- Spec 8 has `adapter-azure-blob` declare all three and send a conditional `delete` as one
  `Delete Blob`. The table of 8.8 gains `BlobAlreadyExists` and `ConditionNotMet`, which takes
  `BlobAlreadyExists` out of the rule that an unnamed `409` on `Put Blob From URL` is
  `InvalidRequest`.
- Spec 9 has `adapter-gcs` declare all three, names the requests that carry `ifGenerationMatch` and
  the form of a generation, and sends a conditional `delete` as one `DELETE`. The row of 9.8 that
  maps `conditionNotMet` to `ProviderError` because stowage sends no precondition gives it to
  `PreconditionFailed`.
- The README of `adapter-s3` names `deleteIfUnchanged` among the capabilities it does not declare,
  with R2 as the reason.
- An answer without `ETag` or `generation` where it feeds a description is `ProviderError` on all
  three cloud adapters.
- `adapter-s3` leans on a beta of R2 for the copy destination. Losing it withdraws
  `writeIfAbsent` and `writeIfUnchanged` from `adapter-s3`.
- #448 measures a multi-call `rewriteTo` under `ifGenerationMatch`. A finding that GCS refuses or
  needs something else on the later calls amends this ADR before the spec is written.
- Which cases run against the emulators and which against the real endpoints alone, given what
  SeaweedFS, Azurite and fake-gcs-server drop, is #446's.
- The README of `adapter-s3` also names among its limits that the conditional `copy` on R2 rests
  on Cloudflare's beta `cf-copy-destination-if-*` headers (settled while writing the v0.7 spec,
  #447).
