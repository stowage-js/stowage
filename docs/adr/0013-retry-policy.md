# Retries follow the condition, three attempts to a request

ADR 0003 promises that the S3 adapter repeats failures that are safe to repeat, with capped
exponential backoff and jitter, on by default and switchable off, and leaves the group open. The
group is decided by the condition alone: a transport failure that never received a response, and
the statuses `408`, `429` and every `5xx`. The provider code adds nothing on top, because
`SlowDown` and `InternalError` arrive under `503` and `500` anyway, and a table keyed on provider
codes would treat a code stowage has not heard of worse than one it has, which is backwards for an
unknown `5xx`. `RequestTimeTooSkewed` stays out: it arrives with `403`, and a second request signed
against the same wrong clock fails the same way. Reading the provider's `Date` header and signing
against the offset is a separate feature, and v0.1 does not have it.

The operation does not narrow the group, with one exception. `CompleteMultipartUpload` is not
repeated after a transport failure that received no response, because the completion may have been
committed, and the second request would then meet an upload id that is gone and report `NotFound`
where the first request succeeded. `CreateMultipartUpload` is repeated, and an upload the first
request may have created is left behind. ADR 0005 already says that parts stay and are charged for
when a failed upload cannot abort itself, and the remedy is the same one: a lifecycle rule for
incomplete uploads on the bucket, which ADR 0012 requires on the conformance buckets anyway.

What may be repeated at all is decided by the body. A part is held whole in memory in order to be
signed (ADR 0009), so it goes out again from that buffer. A body the caller supplied as a stream
does not: once `fetch` has read it there is nothing left to send, and `fetch` offers no way to
learn whether a byte was read before the failure. A request carrying a stream is therefore never
repeated, not even when it failed while connecting. The cost falls on a single `PUT` of known
length, which ADR 0009 sends as one request: a caller who streams five gigabytes gets no retry.
Sending every upload through multipart so that each part is buffered would buy that retry and
would charge every small upload three requests in place of one; that trade belongs to the
multipart semantics rather than here.

The budget belongs to the HTTP request rather than to the operation, and it is three attempts, the
original and two repeats. Per operation, an upload of two hundred parts would spend everything on
part three and hold nothing for part two hundred. Three rather than the ten `aws4fetch` takes:
under a five second ceiling on the delay, ten attempts per part let one upload sit for an hour
with nothing to show for it. There is no total time budget, because the caller holds one already —
the `AbortSignal` every operation accepts, which interrupts the wait between attempts as well.

The wait is full jitter, a random delay between zero and `min(5s, 100ms * 2^n)`. Neither promised
provider is documented to send a `Retry-After` header on its S3 API: AWS gives exponential backoff
as the answer to `503 SlowDown`, and R2's error table says the same for its `503` and `500`. The
adapter therefore does not read one. Honoring a header no promised provider sends would be code
that no test could cover, since the endpoints of ADR 0012 cannot produce it either.

The caller gets one knob, `retry?: false | { maxAttempts?: number }`, on `S3AdapterOptions`.
Retrying is transport behavior rather than semantics (ADR 0003), so it sits on the concrete
adapter type where ADR 0004 puts provider options, and not in the core interface. `@stowage/core`
exports the loop and the table of transient conditions so that there is one definition of both;
`adapter-fs` and `adapter-memory` do not call it. There is no `baseDelay`, no `maxDelay`, no
`shouldRetry` hook and no `onRetry` callback, and no per-call override. A hook would hand the
decision this ADR makes back to the caller, and the two numbers are what the caller would have to
guess at without the measurements that produced them.

There is no timeout per attempt, and that is a gap rather than an oversight: without one, a
connection that hangs holds the operation open and no retry ever starts. `fetch` cannot separate
the time spent connecting from the time spent reading a body, so a single number would either cut
off a five gigabyte `PUT` or be too long to help a dead connect. The caller has
`AbortSignal.timeout()` and knows which of the two it is running.

The error says what happened. `attempts` joins the fields ADR 0005 lists and counts the requests
actually sent, so a failure that was never repeated carries `1`. `retryable` keeps the meaning ADR
0005 gave it: it describes the condition and not the course. A transport failure on a stream body
therefore arrives with `retryable: true` and `attempts: 1`, which is the honest pair — the
condition would have passed, and nothing could be sent again. For the same reason `adapter-fs`
retries nothing and still sets `retryable` where the condition is transient, on `EMFILE`, `EBUSY`
and `EAGAIN`; `adapter-memory` has no transient condition and never sets it.

`Expired` keeps the rule ADR 0007 gave it and counts on its own: one repeat, with `forceRefresh`
in front of it and no delay, since waiting does not make a credential fresher. Its budget is
separate from the three attempts, so one request costs at most six. `retry: false` does not switch
it off, because it is how a caching resolver is told to refresh rather than a repeat of the
transport, and without it an expired credential has no way back.

Every attempt resolves credentials again and signs again. ADR 0007 resolves before every signed
request, and an attempt is one. A signature stays valid for fifteen minutes and three attempts fit
far inside that, so reusing one would work — and it would turn that window into a promise in
exchange for an operation that costs nothing. The payload hash is not computed again: it belongs
to the bytes rather than to the attempt.

`delete` does not repeat a failure of a single key. `DeleteObjects` answers `200` and carries
those failures in its body, so nothing in the group applies to them, and repeating them would mean
a second request over a subset of the keys, with a budget of its own and a report assembled from
two answers. The entry in `failed` carries `retryable` instead, and deleting is idempotent, so a
caller who wants the repeat can make it. `deleteAll` follows the same rule per page.

A body stream that breaks partway through `get` is not resumed. Reading on with `Range`, guarded
by `If-Match` against an object overwritten in between, is a second retry mechanism spanning a
whole read rather than one request, and it needs `rangeReads`, which an adapter may not declare.
No reference flow asks for it. The failure arrives as ADR 0005 promises, with `attempts: 1`.

What the conformance suite can say about any of this is what the core API shows, which is
`retryable` and `attempts` on failures the suite provokes anyway. Three cases carry it. In the
fast tier, `get` on an absent key and a storage from `createStorageWithBadCredentials()` both have
to report `retryable: false` and `attempts: 1`, which is the evidence that a condition that will
not pass is not repeated. In the slow tier, a storage from `createStorageWithExpiredCredentials()`
has to report `Expired` with `attempts: 2`: ADR 0012 makes that credential a static 900 second STS
token, so a resolver that answers the same thing to `forceRefresh` produces exactly two requests,
and the rule of ADR 0007 becomes visible through the public API. That case stays out against R2,
where ADR 0012 already skips it. The curve, the group itself, the two exceptions and the stream
rule are none of them reachable from the API — no endpoint of ADR 0012 returns a `503` on request
— so they become tests of this repository against a stubbed `fetch`, which is where ADR 0006 put
flat memory and the broken body stream for the same reason.

## Consequences

- One request costs at most six HTTP requests: three attempts, doubled by the separate `Expired`
  repeat.
- `retry: false` still sends two requests when a credential has expired. The ADR says so because
  the combination looks like a leak otherwise.
- A caller who streams a body of known length into `put` gets no retry on it, while the same bytes
  handed over as a `Uint8Array` get three attempts.
- On `workerd`, every repeat spends one more subrequest from the budget ADR 0002 names, so a paged
  listing under load can run out. Nothing detects the runtime, because ADR 0002 forbids it; the
  lever is `maxAttempts` or `retry: false`, set by a caller who knows where the code runs.
- A hanging connection is not interrupted. The operation waits until the caller's `AbortSignal`
  fires.
- `attempts` is a new field on `StorageError`, and ADR 0005 lists it with the rest.
- A failed `CreateMultipartUpload` that was repeated can leave an upload the abort path never
  learns about, and only a lifecycle rule removes it.
- The defaults — three attempts, 100 milliseconds, five seconds — are not part of what a caller
  can rely on. Whether changing them counts as breaking belongs to the release policy.
