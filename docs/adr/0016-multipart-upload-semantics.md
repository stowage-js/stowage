# The body type decides how an upload is sent

ADR 0009 fixed the part size and left the rest of a multipart upload unassigned. What decides the
shape of an upload is the type of the body: bytes the adapter holds — a `Uint8Array` or a string —
go as one `PUT`, and a `ReadableStream` is read into parts and becomes a multipart upload as soon
as it fills more than one. ADR 0009 wrote that rule as the total length being known and gave as its
reason that the bytes are already in memory. Those are not the same test, and the reason is the
right one: a stream can carry a known length and still have nothing left to send once `fetch` has
read it. Taking the reason as the rule means every request the adapter sends carries a body it can
send again, which closes what ADR 0013 left open — a caller who streamed five gigabytes got no
retry at all.

Sending every upload through multipart was the other way to close it, and it charges every small
upload three requests in place of one. The body type charges the round trips only where the body is
a stream: a hundred megabytes go as thirteen parts rather than as one request, while a stream below
one part is buffered whole and goes as the single `PUT` that bytes get.

`put` accepts `Uint8Array`, a string and `ReadableStream<Uint8Array>`. A `Blob` is neither side of
the rule: it can be read a second time like bytes and it can be backed by a file like a stream, and
no documentation of the four runtimes says whether `fetch` holds one whole. `blob.stream()` is one
line at the call site, and an `ArrayBuffer` is `new Uint8Array(buf)`. Every further type is another
path through parting, hashing and repeating, and another row in the conformance matrix.

The parts in flight are `multipart?: { partSize?: number; concurrency?: number }` on
`S3AdapterOptions`, beside the `retry` of ADR 0013 and where ADR 0004 puts provider options. The
defaults are 8 MiB and four; `partSize` takes 5 MiB to 5 GiB, which is the range both providers
document for a part, and `concurrency` takes one to sixteen. Anything else is `InvalidOption` at
construction rather than clamped, as ADR 0013 refuses a `maxAttempts` outside its range. The memory
held for multipart part buffers is the product of the two, 32 MiB by default, for an object of any
size. The single-`PUT` path is outside that bound: a `Uint8Array` or string may retain the complete
request body in memory, as ADR 0009 notes.

The multipart-buffer statement does not vary with a stream's declared length. ADR 0009 raised the
part size up front where the total length was known, so that 10,000 parts cover the object. Once the
body type decides the shape, a declared length has one use left and it appears above
78 GiB, where it multiplies by the parts in flight: a terabyte announced means 110 MiB parts, four
of them in memory at once. `put` therefore takes no length, the raise is gone, and a stream above
roughly 78 GiB fails at the 10,000-part limit with an error naming the configured part size — which
is what ADR 0009 already described for a body whose length nobody knew.

A part that fails is repeated inside the upload, on ADR 0013's budget of three attempts to an HTTP
request, sent again from the buffer ADR 0009 holds for the hash. The upload fails once one part has
spent that budget, and there is no second budget over the upload as a whole: the caller's
`AbortSignal` is one, which is the argument ADR 0013 makes for counting per request. When a part
does fail for good, the parts still in flight are cancelled, the source stream is cancelled, and the
upload aborts itself. R2 documents that uploading to a part number again replaces the part that was
there and that the earlier one is lost if the second attempt fails, so a repeat is never merely
redundant — from the moment it starts it is the only copy.

An `AbortSignal` the caller fires aborts the upload at the provider as well. The request that does
it cannot carry the signal that has just fired, so it goes without one, and what the caller then
sees is the runtime's `AbortError` rather than a `StorageError`, which is the split ADR 0005 draws.
A failure of that abort request is not reported: the caller asked to stop, and ADR 0005 already
states what parts left behind cost.

`CompleteMultipartUpload` after a transport failure that received no answer is the one exception to
ADR 0005's rule that a failed multipart upload aborts itself. ADR 0013 does not repeat that request
because the commit may have happened, and for the same reason the adapter does not abort: a commit
may still be travelling. The caller gets `NetworkError` with `retryable: true` and `attempts: 1`,
and `stat` can settle which happened only for a key confirmed absent before the upload, with no
competing writer: finding the key then proves that a commit created it. If an object may already
have occupied the key, `stat` cannot distinguish that object from the completed upload, so the
outcome remains ambiguous. There is no field for it and no code of its own, because one ambiguous
case does not justify a shape every caller has to read.

`CopyObject` goes out first, and only the provider's refusal of a source that is too large reaches
the possible ranged `UploadPartCopy` fallback. Each range would have to name the same immutable
source version; otherwise replacement during the operation could assemble one destination from
different source objects. `x-amz-copy-source-if-match` is not a source pin for this purpose and is
not used for `UploadPartCopy`. Because v0.1 excludes versioning, it cannot name a pinned source
version and rejects the fallback without creating a multipart upload. A future fallback may proceed
only when it can pin every part to one source version or read from a stable snapshot. Reacting to
the provider's refusal rather than to a number known per provider still keeps the adapter blind
(ADR 0014) and spares the common copy a preliminary `HEAD`. `move` inherits the refusal.

The provider-refusal path is covered against a stubbed `fetch`, where ADR 0006 and ADR 0013 already
put flat memory, the broken body stream and the backoff curve. Nothing in CI needs a source above
5 GB merely to verify that v0.1 refuses an unpinned multipart-copy fallback.

Nothing of any of this reaches the core API. There is no progress callback: the core interface is
closed (ADR 0004), an option on `put` would be parity core and every adapter would owe it, and none
of the five reference flows asks for one. What a caller wants there is a byte counter, which is a
`TransformStream` in front of `put` and belongs in the README. No upload id leaves the adapter, so
there is nothing to resume from and no event per part. The only visible trace of a multipart upload
is the option group above, on the concrete adapter type.

The conformance suite gets three cases, all in the fast tier and none requiring a capability. A
multipart round trip writes 17 MiB from a `ReadableStream` — the suite cannot set `partSize`,
because construction belongs to the target, so it has to pass the 8 MiB default twice over — and
reads it back byte for byte with `stat` reporting the size; the content is a generated pattern
rather than random bytes, so a mismatch says where it is. An abort during that upload has to reject
with `err.name === "AbortError"` and not with a `StorageError`, which is the one place the split of
ADR 0005 is observable through the API. An object of length zero, written once from an empty
`Uint8Array` and once from a stream that yields nothing, has to report a size of zero. For
`adapter-memory` and `adapter-fs` the first case is a large write and nothing more, and that is the
point: the case checks the promise, not the construction, which is the rule ADR 0006 states.

## Consequences

- `put` accepts `Uint8Array`, a string and `ReadableStream<Uint8Array>`. A caller holding a `Blob`
  or a `File` passes `blob.stream()`, and the README shows it.
- Multipart part buffers hold `partSize × concurrency` bytes, 32 MiB by default, whatever the
  object weighs. A single `PUT` from a `Uint8Array` or string may retain the complete request body
  instead. There is no option whose effect appears only above 78 GiB, and no multipart upload whose
  memory depends on what the caller announced.
- A stream above roughly 78 GiB needs a larger `partSize`, and the error says so. The 10,000-part
  limit is the provider's on both sides.
- Every request `adapter-s3` sends carries a body it can send again, so ADR 0013's rule that a
  request carrying a stream is never repeated no longer costs a caller anything at `put`: the
  streamed bytes travel as buffered parts, each with its three attempts.
- A hundred megabytes handed over as a stream cost fifteen requests where one `PUT` was sent
  before. This is the price of the retry, and it is paid by streams alone.
- On `workerd` four parts in flight sit under the six simultaneous connections Cloudflare documents,
  and an upload spends two subrequests plus one per part. ADR 0002 gives flow 1 its cell on
  `workerd`, and nothing here takes it away.
- A multipart upload aborts itself on failure and on the caller's abort, with one exception:
  `CompleteMultipartUpload` that received no answer. ADR 0005 carries the exception.
- `copy` first tries `CopyObject`. If the provider refuses because the source is too large, v0.1
  rejects the operation rather than issue `UploadPartCopy` requests against an unpinned source.
  Version pinning and versioning remain outside v0.1.
- v0.1 offers nothing for an upload a dead process left behind. On AWS the remedy is the lifecycle
  rule ADR 0005 already names, on R2 the seven-day default ADR 0014 records. A cleanup operation is
  worth building once someone runs a bucket where no lifecycle rule can be set: it fits no adapter
  but one, so it would arrive as a capability or on the concrete type.
- ADR 0024 and ADR 0025 amend this for the Azure adapter: a block upload that commits by
  `<Latest>` and leaves its blocks to the service, and a copy refused above 5,000 MiB with no
  fallback.
- The defaults, 8 MiB and four parts, are not something a caller can rely on, as the backoff numbers
  of ADR 0013 are not, so ADR 0017 moves them in a minor release and never in a patch.
- Adding a body type later takes nothing from a caller. `Blob` is the candidate, and what it waits
  for is a measurement of what `fetch` does with a file-backed one on each of the four runtimes.
