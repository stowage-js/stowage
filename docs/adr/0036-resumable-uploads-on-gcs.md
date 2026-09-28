# A streamed upload to GCS is one resumable session, sent a chunk at a time, whose commit can be repeated

ADR 0016 decides how a streamed `put` is sent, and ADR 0013 which of its requests are repeated.
Both were written around S3's multipart upload: parts in flight side by side, an abort that removes
them, and a completion that cannot be sent twice. The JSON API that ADR 0031 chose uploads a stream
through a resumable session instead: one `POST` that answers with a session URI, then chunks `PUT`
to that URI one after another, each a multiple of 256 KiB except the last, the last naming the
total, and a `DELETE` of the URI that cancels. This amends both ADRs for `@stowage/adapter-gcs`;
what they decide for `adapter-s3` stands, and ADR 0024 for Azure. The points the reference left
open were measured against the measurement bucket on 2026-09-28 on Node, Bun and Deno, which
answered alike, on branch `spike/gcs-resumable`. `workerd` was not measured, because it could not
resolve the host from inside the sandbox.

The body type still decides the shape. A `Uint8Array` or string goes as one `uploadType=multipart`
request, a `multipart/related` body holding the object resource with name, content type and user
metadata, then the bytes, up to the 5 TiB an object holds; the adapter does not split held bytes. A
stream that ends within one part goes as the same request, and a longer one goes as a session.

The option is `multipart?: { partSize?: number }`, without `concurrency`. A session takes one chunk
at a time, so a count of parts in flight would govern nothing, and an option that does nothing is a
promise the adapter cannot keep. Reading the next part while one is sent was the one thing it could
have meant, and it would have changed the core, since `uploadStream` reads a part only once another
settled, for throughput that no reference flow asks for. `partSize` is 8 MiB by default, Google's
recommended minimum for a chunk, and takes multiples of 256 KiB from 256 KiB to 5 GiB; anything
else is `InvalidOption`. GCS states no largest chunk, so the upper bound is S3's rather than the
provider's. A default of 32 MiB would have kept the 32 MiB of part buffers that S3 and Azure hold
with a quarter of the requests, and the 17 MiB stream of `put/multipart` would then go as one
request, leaving no case of the suite that sends a session. The part buffers here are `partSize`,
8 MiB by default. A session has no part limit, and the object's 5 TiB is the provider's to refuse
on the chunk that crosses it; the core's refusal above `maxParts` names a larger `partSize` as the
way past, which would be false here, so the adapter hands `uploadStream` no limit.

Part `i` goes at offset `i × partSize`. A part shorter than `partSize` is the last one, carries
`Content-Range: bytes <first>-<last>/<total>`, and commits. A full part carries `/*` in place of the
total, because the core reads the next part only once this one settled and cannot say whether it
is the last. When the last part was full, an empty request with `bytes */<total>` commits after
`sendParts` resolved; measured, it answers `200` with the object like a last chunk does. Either
commit answers with the object resource, which is what `put` resolves with, so no `stat` follows.
The alternative was a flag on `send` saying which part is the last, which would have had the core
read ahead of every adapter's parts to serve one.

GCS may persist less of a chunk than it was sent, and the adapter has to read the `Range` of every
`308` rather than assume the chunk arrived. Measured, a chunk of 300 KiB sent with `/*` was kept
to the last 256 KiB boundary and the rest dropped, without an error. When the acknowledged range
ends inside the part, the adapter sends the rest of the part from the buffer it holds, at the
acknowledged offset, and the part settles only once its last byte is acknowledged or the session
committed. That is progress and not a failure, and it spends no attempt. A `308` that acknowledges
nothing beyond the last one counts as a failed attempt on the part's budget, so a session that
stops moving ends the upload rather than looping. A range that ends before the part's first byte or
beyond what was sent is `ProviderError`: the session has lost bytes the adapter already let go of.
The `308` reaches the adapter as it is on every runtime measured, under `redirect: "follow"` too,
since it carries no `Location`.

Every request of a session is repeated as it was sent, on ADR 0013's budget and condition.
Persisted bytes sent again are ignored, even when their content differs, and a chunk that overlaps
the persisted end has the rest appended; both were measured. So a chunk whose answer was lost goes
again whole, and the adapter never sends a status query. That is also why fake-gcs-server
committing an upload on a status query (ADR 0034) never meets the adapter. The start of a session
is repeated as `CreateMultipartUpload` is on S3, and a session that an earlier attempt created
stays unseen and expires a week after it started.

The commit can be repeated as well. Measured, the last chunk sent again after its `200` answers
`200` with the same object and generation, also with other bytes in it, and so does a status query;
the first commit stands. ADR 0013's exception for `CompleteMultipartUpload`, and the ambiguous
outcome of spec 7.7 that ADR 0016 draws from it, do not exist here. One case is left: the commit's
budget spent without a single answer. The adapter then sends the session's `DELETE` without a
signal and reads its answer. A committed session answers `200` with the object and keeps it, as
measured, and `put` resolves with that object. An open session answers `499` and is gone, and `put`
rejects with the commit's `NetworkError`. No answer to the `DELETE` either leaves `put` rejecting
with that `NetworkError`, as any request whose budget went unanswered does. The `DELETE` is the one
the failure path sends anyway, so settling the commit costs no request of its own.

A failed or aborted upload cancels itself, which keeps ADR 0005's rule rather than ADR 0024's
exception. When a part has spent its budget, the source stream is canceled, the session's `DELETE`
goes out without a signal, and `put` rejects with that part's error; the caller's abort does the
same and rejects with `AbortError`. A failure of the `DELETE` is not reported. `DELETE` answers
`499 clientClosedRequest`, and every later request to the URI answers the same. Where the `DELETE`
does not arrive, what is left is a session holding the bytes persisted so far, which `stat`, `get`
and `list` do not see and which the service removes a week after the session started. Nothing a
caller observes changes: the key is absent or holds what it held before.

The session URI authorizes the chunks on its own. Measured, a chunk without `Authorization` is
accepted, and so is one carrying `Bearer not-a-token`: the service does not check a token there. The
chunks, the empty commit and the `DELETE` therefore go without one, and the credential is resolved
once per streamed `put`, for the start. That departs from ADR 0007's "resolved before every
request", which is named here. The rule stands for every request that carries a credential; these
carry none, and a token no one checks would cost a call of the resolver per chunk and suggest a
check that does not happen. An upload that runs longer than its token lives needs no refresh. ADR
0033 left this point to uploads. Since the URI is itself a credential for a week, it never leaves
the adapter: not in a message, a `cause` or any field.

Two sessions for one name are independent, and the later commit wins; two commits side by side
both answered `200`. GCS documents one write per second to one name and `429` above it. The run
met none in six writes within half a second. A `429` falls under ADR 0013's repeat, which may
recover the collision and does not promise to, as for R2's same-key window. `put/concurrent-writers`
holds as written.

Nothing reaches `@stowage/core`. `uploadStream` serves the session as it is: `concurrency` 1, no
limit on parts, the rest of a short acknowledgement sent inside the `send` callback, which holds its
buffer until it settles, and the empty commit inside the `multipart` callback after `sendParts`.
The `multipart/related` writer is needed by this adapter alone, so ADR 0019's rule keeps it there.

What the API cannot show becomes tests of the adapter against a stubbed `fetch`, where ADR 0006 and
ADR 0013 already put the backoff curve and the broken stream: a chunk repeated whole after a lost
answer, a short acknowledgement answered with the rest of the part, a `308` that moves nothing
spending an attempt, a repeated commit, and the `DELETE` after an unanswered commit meeting `200`
and `499`. The answers they stub are the spike's. storage-testbench is not used. The cases of ADR
0016 hold unchanged and run against both endpoints of ADR 0034. fake-gcs-server ignores a chunk's
offset, so a repeated chunk would be appended twice there, and the per-commit run injects no
failure that would repeat one.

## Consequences

- `GcsAdapterOptions` has `multipart?: { partSize?: number }` and no `concurrency`. A configuration
  shared with `adapter-s3` or `adapter-azure-blob` keeps its `partSize` a multiple of 256 KiB.
- A streamed `put` to GCS holds 8 MiB of part buffers by default, a quarter of S3 and Azure, and
  sends its chunks in sequence, so it takes longer than theirs for the same bytes.
- A stream costs one request for the start, one per part, one per short acknowledgement, and one for
  the empty commit when the last part is full. Flow 1's cell on `workerd` under Cloudflare's
  subrequest limits is for the decision on the runtime matrix.
- Section 7.7 stays S3's alone. The GCS adapter answers a `put` of any size with certainty, except
  where both the commit and the `DELETE` after it went unanswered.
- A failed upload to GCS leaves nothing the API shows. A session whose `DELETE` did not arrive
  keeps its persisted bytes for up to a week, and the conformance bucket of ADR 0034 carries them
  the same way, which its lack of a rule for incomplete uploads already assumed.
- Spec 4.13 says that `maxParts` may be `Infinity`. `uploadStream` does not change.
- `499`, the `503` in plain text that a chunk leaving a gap meets, and the empty `400` for a total
  below what is persisted go to the provider code table, which the decision on provider codes
  writes. The adapter sends neither of the last two by construction.
- The session URI is a credential for a week and is treated as one. A caller who logs a
  `StorageError` does not log it.
- `workerd` was not measured. The `308` there follows the Fetch standard as on the three runtimes
  measured, and `put/multipart` on `workerd` against the real bucket shows it on the first
  scheduled run.
