# `copy` on GCS loops `rewriteTo` under the service's pin, and `move` is one `objects.move`

Section 4.11 has `copy` create the destination with the bytes, content type and user metadata of
the source, replacing any object there, leave the destination as it was on failure, and resolve
once it exists. `move` is `copy` then `delete`. On S3 and Azure one request either does that or is
refused as too large, and ADR 0016 and ADR 0025 decline a fallback in several requests because
neither provider can tie every request to one version of the source. The JSON API that ADR 0031
chose offers three calls: `copyTo`, which is one call; `rewriteTo`, which may answer
`done: false` with a `rewriteToken` to continue with; and `objects.move`, an atomic rename within
a bucket. The points the reference left open were measured against the measurement bucket on
2026-09-28 on Node, and against fake-gcs-server 1.56.1, on branch `spike/gcs-copy`.

`copy` sends `rewriteTo` with an empty body and sends it again with the `rewriteToken` of each
answer until one says `done: true`, whose object resource is what `copy` resolves with. It sets no
`maxBytesRewrittenPerCall` and no bound of its own; the service's 5 TiB is the limit. A copy within
one storage class answered `done` in one call in 130 ms at 3 GiB, since the service copies no
bytes for it, so the common copy costs one request, as on S3 and Azure. A copy whose storage class
changes copies the bytes: 3 GiB from `NEARLINE` took one call of 10 s, 12 GiB took a call of 28 s
answering `done: false` at 9.9 GB and a second of 8 s. `copyTo` of the same 12 GiB answered
`413 uploadTooLarge` after 28 s, "Copy spanning locations and/or storage classes could not
complete within 30 seconds", which is the refusal ADR 0016 and ADR 0025 pass on as
`InvalidRequest`. Passing it on here would refuse a copy the service offers to finish, for a source
in a class the map allows, so `copyTo` is not used.

The destination takes the bucket's default storage class, not the source's: with an empty body a
`NEARLINE` source became `STANDARD`, and content type and user metadata came across. Keeping the
source's class would take a `stat` in front and a body carrying the class, the content type and the
metadata, because any body replaces all of them, which is two requests for something outside the
parity core and the metadata travelling through the adapter. A source in `NEARLINE`, `COLDLINE` or
`ARCHIVE` in a `STANDARD` bucket is therefore the case that changes class, that may take several
calls, and that the provider bills for retrieval.

A copy in several requests needs the pin ADR 0016 requires, and the service holds it. A continued
call reads the generation the first call read, and when that generation is gone the call answers
`404 notFound`, "No such object: <bucket>/<key>". Measured, that happened with the source replaced
between two calls and with it deleted, with `sourceGeneration` and without it, and the destination
stayed as it was. The adapter therefore sends no `stat` in front and no `sourceGeneration`. This
amends ADR 0016 for the GCS adapter: the fallback it declines for want of a pinned source is
possible here, because the rewrite token is the pin. The `404` of a continued call is `NotFound`
with `key` set to `from`, with the message word for word, although the key then holds a newer
object where it was replaced; `copy` called again reads that object. Restarting from the first
call on the adapter's own was the other way, and it could copy gigabytes a second time and would
need a number of restarts nobody can justify. A writer racing the source of a copy may make the
copy fail, as section 4.11 already allows two writers to one key to fail.

The destination does not change before the call answering `done`. Measured, an existing
destination kept its generation, content and metadata in `stat` and `list` between calls, an
absent one stayed absent, and a rewrite never continued left nothing. A failed or aborted `copy`
leaves the destination as it was, which section 4.11 asks for, and sends nothing to clean up: an
abandoned token expires after a week and holds nothing a caller sees.

Every call of the loop is one request under ADR 0013, on its own budget, and there is no budget
over the copy as a whole: the caller's `AbortSignal` is that, as ADR 0016 argues for parts. All of
them repeat as sent. Measured, the first call sent again answers with a fresh token, a continued
call sent twice with one token advances both times, and the call answering `done` sent again
answers `200` with the same object and generation.

A missing source answers `404 notFound` "No such object" and a missing bucket `404 notFound` "The
specified bucket does not exist." on `rewriteTo` and `objects.move` alike, as on `stat`. Both are
`NotFound`: with `key` set to `from` for the object, and without a key for the bucket, told apart by
the message as ADR 0032 does for `delete`. The rest of the adapter's code table belongs to the
decision on provider codes. A copy onto itself stays `InvalidRequest` before any request; the
service would have accepted it and written a new generation.

`move` is one `objects.move`, which the method's page and a flat bucket both allow; the resource
page listing it for hierarchical namespace alone is wrong on that point. Measured, it answered in
70 to 85 ms at every size up to 3 GiB, kept bytes, content type, user metadata and storage class,
replaced an existing destination, and left the source `404`; a move onto itself answers `400`,
which the adapter never sends. `copy` then `delete` was the alternative, and it would have made a
`NEARLINE` object `STANDARD` on every move, billed the minimum storage duration of the source it
deletes, and taken several calls where the move takes one. Section 4.11 stays the promise of the
parity core, and no capability states the difference: what a caller observes of a move that
resolves is the same, and a move that fails on GCS leaves source and destination as they were,
which is more than the paragraph on compound operations in section 4.10 promises and asks nothing
of it. `objects.move` also skips soft delete on the source, which the map allows and a caller does
not observe.

`objects.move` is not safe to repeat blindly. A move that happened and whose answer was lost
answers `404` for its source when sent again. The adapter repeats it on ADR 0013's budget and
condition, and a `404` on an attempt after one that received no answer or a `5xx` rejects with that
earlier failure instead of `NotFound`, since the move may have happened: `NetworkError` or
`ProviderError`, `retryable: true`, with `attempts` counting all of them. That later `404` remains
ambiguous unless the adapter can identify the destination as the object committed by this move.
`stat(to)` alone is insufficient when the destination may have pre-existed: finding an object
there does not establish that the move committed. There is no field for it
and no code of its own, for the reason ADR 0016 gives. Not repeating `objects.move` after an
unanswered attempt was the other way, as ADR 0013 does for `CompleteMultipartUpload`, and it would
give up the repeat for the common failure in which nothing was moved.

This amends ADR 0034. fake-gcs-server 1.56.1 has no `moveTo`: every call answers
`400 invalid` "Metadata in the request couldn't decode" and the source stays. `move/round-trip` and
`move/missing-source` go on the divergence list as expected failures, naming that, and run against
the real bucket in the `slow` tier, which ADR 0012 admits; they leave the list when a release
serves `moveTo`, and the missing method is reported to fake-gcs-server. Falling back to `copy` then
`delete` on that `400` would shape the wire around the emulator, which ADR 0025 declines for
Azurite. On Bun and Deno, which ADR 0034 runs against fake-gcs-server alone, `move` then runs
against nothing that serves it; what that means for those cells is for the decision on the runtime
matrix. fake-gcs-server finishes every rewrite in one call, so the loop's continuation never runs
there either.

The loop is covered against a stubbed `fetch`, where ADR 0016 and ADR 0025 put their refusals
above the limit: `done: false` with a token, the token carried to the next call, a `404` on a
continued call, and an abort between two calls. The answers they stub are the spike's.
storage-testbench is not used for it, which settles for copies the point ADR 0034 left open: a
second emulator for one path of one adapter costs more than it checks. Nothing in CI copies above
the single-call range. Forcing several calls takes a class change, and the smallest source that
needs it is some 10 GiB in a class billed for 30 days, about 4 EUR a month run nightly against a
budget of 5 EUR; `maxBytesRewrittenPerCall` as an option for the tests would be a knob no caller
needs.

## Consequences

- Section 7.8 is stated per adapter. On GCS, `copy` sends `rewriteTo` until `done` and succeeds up
  to 5 TiB; there is no refusal above a size of its own. `move` sends one `objects.move`.
- The destination of a `copy` takes the bucket's default storage class. The GCS section of the spec
  says so, and that a source in another class may take several requests and bills retrieval.
- A copy in several requests fails with `NotFound` when its source is replaced or deleted between
  two of them. The spec names that case.
- One call of the loop took 28 s at 12 GiB. There is no timeout per attempt (ADR 0013), and a copy
  of 5 TiB with its class changing is some 550 such calls; what that means on `workerd` is for the
  decision on the runtime matrix.
- The GCS adapter's code table gains the `404` of a continued rewrite; `uploadTooLarge` does not
  reach it, since `copyTo` is not sent. The decision on provider codes writes the table.
- A `move` that received no answer and then a `404` is the GCS adapter's one ambiguous outcome, as
  `CompleteMultipartUpload` is S3's. Section 7.7 gains a sentence for it in the GCS section; the
  compound-operation paragraph of section 4.10 holds unchanged.
- The divergence list of fake-gcs-server gains `move/round-trip` and `move/missing-source`.
  `copy/round-trip`, `copy/overwrites`, `copy/missing-source` and `copy/user-metadata` run
  against both endpoints, and `copy/user-metadata` checks the copied metadata on the real bucket.
- A rewrite is billed as one Class A operation however many calls it takes, and the destination
  takes its full size in capacity. A copy that changes class bills retrieval of the source's bytes.
- ADR 0034's open point on storage-testbench's multi-call `rewrite` is settled: it is not used.
  Whether its fault injection tests retries stays with the decision on provider codes.
