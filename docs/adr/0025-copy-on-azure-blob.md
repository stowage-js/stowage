# `copy` on Azure Blob is one `Put Blob From URL`, and the adapter authorizes its source

Section 4.11 has `copy` create the destination with the bytes, content type and user metadata of
the source, replacing any object there, and resolve once it has. On S3 that is one `CopyObject`,
which either succeeds or leaves the destination as it was. Azure Blob offers three ways to copy
within an account, and only one of them keeps both halves of that promise.

`Copy Blob` may answer `202` with `x-ms-copy-status: pending`, and the service promises no time by
which the copy finishes; it gives up after two weeks. While a copy is pending, the destination is a
committed blob of length zero, which replaces the object that was there as soon as the request
returns and which `stat` and `list` see. A copy that fails or is aborted leaves that empty blob
behind. Polling until `success` would keep the half of the promise about resolving, at the price of
a bound nobody documents, but not the other half: a `copy` that fails would have destroyed the
object at `to`, which no other adapter does, and `move` could not delete its source before the copy
finished. `Copy Blob From URL` is synchronous, and stops at a source of 256 MiB.

`Put Blob From URL` is synchronous up to a source of 5,000 MiB, which is within reach of the 5 GiB
at which S3 refuses `CopyObject` in section 7.8. It answers `201` once the destination exists, and
a failure leaves the destination untouched. The standard properties, `Content-Type` among them, are
copied by default, which the reference documents. That user metadata is copied when the request
names none, the reference does not say; the live recording behind the .NET SDK's test of the
operation at `x-ms-version` 2024-08-04 shows it copied, with the case of each name kept, and the
test asserts it. The request therefore carries neither a content type nor `x-ms-meta-*`, and no
`HEAD` goes in front of it. A `HEAD` would have fetched the metadata, pinned the source by its ETag
through `x-ms-source-if-match`, and turned a missing source into `NotFound` before any write. The
first is the service's default, the pin guards only the gap between two requests, and the third
follows from the error mapping below, so the common copy costs one request, as on S3. Sending the
same request again copies the same source onto the same destination, so it belongs to ADR 0013's
status group like any other request, and the special case the REST research anticipated for
`409 PendingCopyOperation` after a repeated `Copy Blob` never arises.

The source has to be authorized by the request, even within one account. A request signed with
Shared Key does not authorize its source, contrary to a table on the Learn page of the sister
operation: the SDK recordings show a same-account source answering `401 CannotVerifyCopySource`
until the request authorizes it. Under `{ accountKey }` the adapter signs a service SAS for the
source and appends it to the URL in `x-ms-copy-source`, with the key resolved for that attempt, so
each attempt carries its own. Under `{ accessToken }` the request carries
`x-ms-copy-source-authorization: Bearer` with the same token as its own `Authorization`, so the
single refresh ADR 0021 makes after `401 InvalidAuthenticationInfo` renews both at once. A user
delegation SAS for the source under an access token was the alternative, and would have let the
emulator check the source on every commit, as the last section describes. It costs a
`Get User Delegation Key` in front of every copy, since ADR 0022 caches no key, and it would shape
the wire around the emulator. Refusing `copy` under an account key, as `presignPut` is refused,
was never needed: an account key can sign a service SAS, and what `presignPut` lacks is the user
delegation SAS alone.

A failure on the source arrives as `CannotVerifyCopySource`, and the recorded answers carry the
source's status as their own: `401` for a source without authorization, `403` for one the principal
may not read. From `x-ms-version` 2024-02-04 on, `x-ms-copy-source-status-code` and
`x-ms-copy-source-error-code` name the source's answer, and the adapter pins a later version. The
adapter maps `CannotVerifyCopySource` by `x-ms-copy-source-status-code` where it is present and by
the response's status otherwise, through the status mapping of section 4.10, with `key` set to
`from`. A missing source is then `NotFound`, which is what `copy/missing-source` asks for, and the
`500 CannotVerifyCopySource` the error table lists for a source that could not be verified in time
is a `ProviderError` with `retryable: true`.

Above 5,000 MiB the service answers `409`, and the reference names no code for it. This amends
ADR 0016 for the Azure adapter. An unrecognized `409` on `Put Blob From URL` is `InvalidRequest`,
saying that the source is above 5,000 MiB or returned no valid length; the codes the adapter's
table in section 8.8 of the spec recognizes, such as `PendingCopyOperation` or `BlobArchived`,
decide first. That keeps
ADR 0016's rule of reacting to the provider's refusal rather than checking a size up front. The
fallback ADR 0016 declines on S3 for want of a pinned source version is declined on Azure for the
same want: it would be ranges of `Put Block From URL` and one `Put Block List`, and that operation
documents no source conditional header at all, so no block can be tied to the source the others
read. `Copy Blob` would have been the other fallback, and is excluded for the reasons above.

`move` is `copy` and then `Delete Blob` on `from`, sent without a condition, as on S3. The copy has
finished when it resolves, so there is no pending copy for the delete to break, and the paragraph
on compound operations in section 4.10 holds unchanged.

This amends ADR 0023 as well. Azurite 3.37.0, the image pinned there, does not implement
`Put Blob From URL`. Its implementation was merged on `main` after that release (Azure/Azurite#2749,
labelled for 3.38.0), reads the source through a loopback request that checks a SAS on the source
URL, and ignores `x-ms-copy-source-authorization`. Since the suite runs under an access token, the
cases that send a copy fail against Azurite before and after 3.38.0: `copy/round-trip`,
`copy/overwrites`, `copy/missing-source`, `copy/user-metadata`, `move/round-trip` and
`move/missing-source`. They go on the divergence list, which ADR 0012 admits because the same
cases run against the real account in the `slow` tier, and they leave it once an Azurite release
reads the header. The pin moves to the first release that carries `Put Blob From URL`, in a commit
of its own, and from then the harness test that checks the account key against both endpoints
copies an object as well, which checks the service SAS for the source on every commit. Until then
that part of the test reports itself skipped. The missing header is reported to Azurite.

## Consequences

- Section 7.8 is stated per adapter. On Azure, `copy` sends one `Put Blob From URL`, succeeds up to
  a source of 5,000 MiB, and rejects above it with `InvalidRequest`; `move` inherits that. Copying
  a key onto itself stays `InvalidRequest` before any request.
- The source SAS carries `sv=2026-04-06`, `sr=b`, `sp=r` and the `spr` ADR 0022 sets, with `st`
  15 minutes in the past and `se` 60 minutes from now, no `srh` and no response overrides. Whether
  the service checks the SAS once or again while it reads a source of several gigabytes is not
  documented; 60 minutes is meant to cover the largest copy with room to spare, and a copy that
  outlasts it would answer `CannotVerifyCopySource` with `403`.
- The Azure adapter's code table gains `CannotVerifyCopySource`, mapped through the source's
  status, and the unrecognized `409` on a copy. The adapter sends no source condition, so
  `SourceConditionNotMet` does not reach it.
- The refusal above 5,000 MiB is covered against a stubbed `fetch`, where ADR 0016 puts S3's.
- The first run against the real account settles four points. `copy/user-metadata` checks that the
  metadata is copied by default at `2026-04-06`, as recorded at `2024-08-04`. `copy/round-trip`
  checks that the bearer header authorizes the source. The harness test checks the service SAS
  under the account key. And a test in the `slow` tier measures once the code of the `409` for a
  source above 5,000 MiB, assembled on the service from blocks with `Put Block From URL` so that
  nothing is uploaded, and the code then joins the table.
- The identity holding Storage Blob Data Contributor reads the source as well. The denied identity
  of ADR 0023, holding Storage Blob Data Reader, fails a copy at the destination with
  `403 AuthorizationPermissionMismatch`, which is `AccessDenied`; no case needs adding.
- A copy bills one write on the destination and one read on the source, and the destination takes
  its full size in capacity, since two blobs share no blocks.
- The six copy cases stay divergent on Azurite for as long as Azurite ignores
  `x-ms-copy-source-authorization`, and the scheduled run is the only place where the adapter's
  `copy` meets a check under an access token. A regression there shows within a day, not within
  the pull request.
- ADR 0029 has user metadata keys stored and read in lower case. A copy keeps the case a source
  another tool wrote, and a read of the destination hands it back in lower case.
