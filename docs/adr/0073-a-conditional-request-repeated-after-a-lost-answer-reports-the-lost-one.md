# A conditional request repeated after a lost answer reports the lost one

ADR 0070 gave preconditions their shape, ADR 0071 and ADR 0072 settled what each adapter declares
and how it reads a refusal. This records what a repeat does to a precondition (#443). ADR 0013
repeats a request after a transport failure that received no response and after a `5xx`, and
either may hide a write that happened. Measured on every promised provider
(`docs/research/provider-preconditions.md` on `research/provider-preconditions`), a conditional
write or delete that succeeded and is sent again meets its own result: `onlyIf: "absent"` meets
the object it wrote, `onlyIf: { etag }` meets the `etag` it produced, and a conditional delete meets
the absence it left. The repeat is refused, and the refusal reads exactly as another writer's
would. Only a repeated AWS `CompleteMultipartUpload` and a repeated GCS resumable commit answer as
the first time did.

The adapter cannot tell its own write from another writer's. S3's `etag` of a single `PUT` is the
MD5 of the bytes, which WebCrypto does not offer; an Azure `etag` and a GCS generation are drawn by
the provider and cannot be known before the answer that was lost. A marker of stowage's own in the
user metadata would put a value into every object that the caller did not write and reads back
through `stat`. None of the libraries in `docs/research/precondition-prior-art.md` tells the two
apart either.

So an adapter repeats a conditional request as it repeats any other, and reads the refusal of a
repeat in the light of what went before. Where an earlier attempt received no response or answered
a `5xx`, a later attempt refused as `PreconditionFailed` rejects with that earlier failure instead:
`NetworkError` or `ProviderError`, `retryable: true`, `attempts` counting every attempt. It is the
rule ADR 0037 gave a `404` after an unanswered `objects.move`, carried to the precondition. `408`
and `429` say that the request was not carried out and do not make a later refusal doubtful. Not
repeating a conditional request after a lost answer, as spec 7.7 does for
`CompleteMultipartUpload`, was the alternative. It reports the same doubt where the repeat would
have reported it, and gives up every case where the first attempt never reached the provider and
the repeat succeeds with certainty.

A conditional `delete` follows the same rule. A `404` after an unanswered attempt, which ADR 0071
makes `PreconditionFailed`, becomes an entry in `failed` carrying the earlier failure. The key holds
no object afterwards and nobody else's object was deleted, but whether this call deleted it is
open, and counting the key as accepted would state what nobody knows. The entry carries
`retryable: true`, and a repeat by the caller answers with certainty.

The caller gets no code of its own for this. `NetworkError` and a `ProviderError` with
`retryable: true` already tell a caller of any write that it may have happened, spec 7.7 and ADR
0037 report their doubts that way, and ADR 0070 kept the code count at one. What a precondition adds
is that calling again with the same `onlyIf` may meet the caller's own object and fail. Spec 4.10
says so and names the way out: `stat` the key, and recognize the write by a value the caller put
into its user metadata, such as an id of its own operation. `OutcomeUnknown` was the alternative,
and spec 7.7 and ADR 0037 would have had to move to it, a change of code on released paths.

Three paths keep a certain answer.

- A GCS resumable session stores its precondition at the start and checks it at the commit. A
  repeated commit that succeeded answers with the same object, and a commit the precondition
  refused leaves the session dead: on the JSON API a status query on it answered `412`, and on the
  XML API every later request did, the cancel included. So the requests of a session take no part
  in the rule: a `412` there is `PreconditionFailed`, and the cleanup of spec 9.6, which cancels
  after an unanswered commit and reads the answer, reads a `412` as the same certain refusal. A
  streamed conditional `put` on `adapter-gcs` is answered with certainty, except where the cancel
  goes unanswered too, as spec 9.6 already has it. The cancel of a dead session on the JSON API was
  not sent; #448 sends it. Should it answer anything but `412`, the cleanup reads it as an open
  session that is gone and rejects with the commit's `NetworkError`, which reports a doubt where
  there was none and never a certainty where there was a doubt.
- `CompleteMultipartUpload` is not repeated after a transport failure (spec 7.7), with or without a
  precondition. After a `5xx` it is, and the repeat of a commit that went through answers `200` on
  AWS and `404 NoSuchUpload` on R2, which also answers that to a commit after one its precondition
  refused, since a refused commit consumes the upload there. On a conditional commit both
  `PreconditionFailed` and `NoSuchUpload` after a `5xx` reject with the `5xx`. An unconditional
  commit on R2 can meet the same `NoSuchUpload` after a `5xx` today and report it as
  `ProviderError`; that predates preconditions and stays outside this decision.
- `adapter-fs` and `adapter-memory` send no request and repeat nothing.

Each path checks the precondition once, at the step that makes the object readable: `PutObject` and
`CompleteMultipartUpload` on S3, `Put Blob` and `Put Block List` on Azure, the insert and the start
of the session on GCS, which GCS checks when the session commits. AWS ignores a precondition on
`CreateMultipartUpload` and refuses one on `UploadPart` with `501`; Azure ignores one on
`Put Block`. R2 checks one on `CreateMultipartUpload` and does not carry it to the commit, so
sending it there would refuse a taken key early on R2 alone, a difference by provider that
ADR 0014 keeps out of `adapter-s3`. No adapter sends a `stat` in front of the first part, for the
reason ADR 0072 gives: a check in front holds nothing.

A commit the precondition refused leaves the key as it was, and what it leaves elsewhere differs.
AWS keeps the upload open, and a later `CompleteMultipartUpload` without the header would commit
it, so `adapter-s3` aborts it, as it does after a failed part (spec 7.6): without the caller's
signal, and without reporting a failure of the abort. R2 has consumed the upload and answers that
abort `204`. Azure keeps the staged blocks until the next commit to the name or for seven days, as
after every stopped block upload (spec 8.6). A GCS session is dead and holds nothing to cancel.
Cleaning up after a dead process stays a non-goal (spec 17).

A `move` whose copy step ends in that doubt throws it and does not delete `from`, as for any failed
copy step (ADR 0070). Both keys may then hold the object, and nothing is lost. Spec 4.10 promises
that a `move` whose delete failed leaves the destination in place and that repeating it is safe.
Repeating a conditional `move` is still safe, as it deletes nothing, but it does not finish: under
`onlyIf: "absent"` it meets the destination it wrote and rejects with `PreconditionFailed`, on
every adapter. The caller finishes it with `delete(from)`, where `deleteIfUnchanged` is declared
with `onlyIf: { etag }` from a `stat` of `from`. This does not conflict with ADR 0017: the promise
was made to `move` without `onlyIf` and holds there unchanged, and the conditional form is new.
Spec 8.5's promise that a `put` of any size is answered with certainty holds for an unconditional
`put` alone, which is the only `put` it was made for.

The rule lives in the request layer the adapters of this repository share, beside ADR 0037's,
which ADR 0057 leaves free to change. `withRetry` stays as spec 4.13 has it. A third-party adapter
that declares one of the three capabilities owes the same behavior, which spec 4.13 states. The
conformance suite cannot provoke a lost answer, so the rule is tested against a stubbed `fetch`,
where ADR 0013 puts the rest of the loop.

Every answer this relies on was observed on its real endpoint, the JSON cancel of a dead session
aside, which #448 measures before the spec is written. Spec section 18 gains nothing.

## Consequences

- Spec 4.10 gains a paragraph on the open outcome of a conditional operation: the earlier failure,
  what calling again with the same `onlyIf` may meet, and `stat` with a value of the caller's own in
  the user metadata as the way to settle it. Its sentence on compound operations narrows for a
  conditional `move`, which is finished with `delete(from)`.
- Spec 4.7 notes the entry a conditional `delete` reports after an unanswered attempt.
- Spec 4.13 has every adapter that declares `writeIfAbsent`, `writeIfUnchanged` or
  `deleteIfUnchanged` report a `PreconditionFailed` after an attempt without a response or with a
  `5xx` as that attempt's failure.
- Spec 7.5 and 7.6 have a conditional `PutObject`, `CopyObject` and `DeleteObject` follow the rule,
  a conditional `CompleteMultipartUpload` read `PreconditionFailed` and `NoSuchUpload` after a
  `5xx` as the `5xx`, and a commit its precondition refused abort the upload. 7.7 is unchanged.
- Spec 8.5 limits the certain answer of `Put Block List` to an unconditional `put`. 8.6 sends the
  precondition on `Put Blob` and `Put Block List` alone.
- Spec 9.5 has the single insert, every `rewriteTo` call, `objects.move` and a conditional `DELETE`
  follow the rule, and the requests of a resumable session read `412` as `PreconditionFailed`. 9.6
  has the cleanup read a `412` as that refusal.
- The rule is a test of this repository against a stubbed `fetch`, per adapter. Which cases the
  suites gain for preconditions is #446's.
- An unconditional `CompleteMultipartUpload` on R2 that meets `NoSuchUpload` after a `5xx` keeps
  reporting `ProviderError`.
