# `adapter-s3` reads the code a refused `HEAD` cannot carry

ADR 0065 left `stat` and `exists` without the refresh it added, because their `HEAD` is answered
without a body and spec 7.9 reads its status alone. The gap is wider than the refresh. Under a
wrong secret `get` reports `InvalidCredentials` and `stat` reports `AccessDenied`, which ADR 0045
calls the one answer that tells the caller the credential was fine. An expired credential reaches
no refresh on either promised provider, and on AWS it reads as `ProviderError`. And the `HEAD` that
describes the destination of `copy` and `move` reads a refusal the same way, after a copy that
succeeded. This decision has a `HEAD` report what `get` reports for the same condition, and the
refresh follows from that.

The answers were measured on 2026-10-08 on Node 24 against the AWS bucket and the R2 bucket of the
scheduled run, with a `HEAD`, a `GET` with `Range: bytes=0-0` and a plain `GET` of an absent key,
each sent twice. No `HEAD` refusal on either provider names its code in a header: beside the
transport headers AWS sends `x-amz-request-id` and `x-amz-id-2`, and R2 sends `cf-ray`. AWS answers
an expired session token with `400`, not the `403` that ADR 0065 and #414 assumed, so `stat` reports
it as `ProviderError` with `retryable: false`, while the `GET` names `ExpiredToken` under the same
status. A wrong secret, under a key pair or a session token, is a bare `403` to the `HEAD` on both
providers, and so are R2's expired temporary credential and R2's refusal of a bucket its token does
not reach. The `GET` names `SignatureDoesNotMatch` for the first two and `AccessDenied` for the
third. In every case the ranged `GET` answered with the status and the code of the plain `GET`,
which is what `get` reports.

A `HEAD` refused with a status that is not transient, `400` to `499` without `408` and `429`, is
followed by a `GET` of the same key with `Range: bytes=0-0`, the request ADR 0043 sends after a
`404`. A `400` to a key above 1024 bytes is not, since spec 7.9 already reads it as `InvalidKey`.
The `GET` is sent like any other request, so `Expired`, and `SignatureDoesNotMatch` under a session
token, lead to its refresh (ADR 0065). Its answer decides:

- Refused with a provider code, the call rejects with the `GET`'s failure: its code, `attempts`,
  `providerCode` and `requestId`. `NoSuchBucket` is `NotFound` without `key` and `NoSuchKey` is
  `NotFound` with it, as ADR 0043 has them, and `exists` answers `false` for the second alone.
- Answered after its refresh, with `206`, or `416` for an empty object, the `HEAD` is sent once
  more and its answer stands as its status reads it, with no request after it. A `404` to that
  `HEAD` is `NotFound` with `key`, since the `GET` found the bucket.
- Answered without a refresh, or refused without a code, as a compatible endpoint may be, the
  `HEAD`'s answer stands, as ADR 0043 had it for a `404` and a writer racing the read.
- Received no response, the call rejects with the `GET`'s `NetworkError`, which `exists`
  rethrows.

The rule holds for every credential, a key pair as well as a temporary one. A key pair refused as
`SignatureDoesNotMatch` gets no refresh, and its `GET` reports `InvalidCredentials` with
`attempts: 1`, which is the point: the code, not only the refresh, is what the `HEAD` could not
carry. One function sends every `HEAD` of the adapter, so the describing `HEAD` of `copy` and
`move` gains the rule, and with it the reading of a missing bucket ADR 0043 gave `stat` and
`exists` alone.

A hit still costs one request. A missing key, a denied one and a refused key pair cost two. An
expired credential the refresh recovers costs four: the `HEAD`, the `GET`, the `GET` under the
refreshed credential and the `HEAD` again. One it does not recover costs three and rejects with
`Expired` or `InvalidCredentials`, `attempts: 2`, as `get` does. Spec 4.5 counts requests for `get`
alone. The second `HEAD` resolves the credential with `forceRefresh: false` and meets the refreshed
one wherever the resolver caches what it was last asked to refresh, and spec 7.3 makes caching the
resolver's job. A resolver that hands back the refused credential there gets the status reading,
since a further follow-up would cost up to six requests and a second `forceRefresh` for one
operation.

Three alternatives were weighed in #414 and while deciding it. A refresh after every refused
`HEAD` under a session token recovers an expired credential and leaves a wrong secret
`AccessDenied`, the gap that remains wider. Reading the `GET` inside the reading of the `HEAD`'s
refusal, so that `sendRequest` refreshes the `HEAD` itself, costs three requests where this costs
four, and makes the further `HEAD` the refresh CONTEXT.md names. It makes `readFailure`
asynchronous and runs a request with its own budget and abort inside the reading of another
request's refusal. `sendRequest` is not part of the spec (ADR 0057), so that stays open should the
fourth request matter. Leaving the gap stated in spec 7.3 was the third.

## Consequences

- Spec 7.9 states the rule for every `HEAD` in place of the ranged `GET` after a `404`. For a `404`
  the outcome stays as ADR 0043 decided it, except that `requestId` and `attempts` are the `GET`'s
  where it names `NoSuchKey`.
- Spec 7.3 says that the refresh reaches `stat`, `exists` and the describing `HEAD` of `copy` and
  `move` through that `GET`, and loses the sentence that they get none.
- Spec 14.5: `errors/bad-credentials` asserts that `stat` rejects with `InvalidCredentials`,
  `retryable: false` and `attempts` of `1` or `2`, as `get` does. `adapter-azure-blob` reads the
  code of a `HEAD` off `x-ms-error-code` and `adapter-gcs` describes an object with a `GET`, so both
  are expected to hold it already; their runs show it. `errors/expired-credentials` asserts that
  `stat` rejects with `Expired` and `attempts: 2`. A tighter case is a minor (ADR 0017).
- Spec 14.4 lists a test against a stubbed `fetch`: a key pair refused at the `HEAD` and the `GET`
  as `InvalidCredentials` with `attempts: 1`; a session token refused as `SignatureDoesNotMatch`,
  then one resolver call with `forceRefresh: true` and the `HEAD` again, which succeeds, or
  `InvalidCredentials` with `attempts: 2` where the refreshed `GET` is refused too; a genuine
  `AccessDenied` in two requests; and the describing `HEAD` of `copy`.
- This narrows what the spec promised for a released adapter, which is a conflict with ADR 0017's
  rule that a withdrawal takes something from the caller. `adapter-s3` withdraws `AccessDenied` from
  `stat`, `exists`, `copy` and `move` for a credential the provider refuses. The change is a minor
  below 1.0, and its changeset starts with `**Breaking:**`.
- It replaces the paragraph of ADR 0043 that sends the ranged `GET` after a `404` and the part of
  its consequence that describes it in spec 7.9, and the paragraph of ADR 0065 on `stat` and
  `exists`, whose statement that AWS's `ExpiredToken` reaches them as `AccessDenied` the measurement
  disproves, and its consequence that spec 7.3 names them as getting no refresh. The rest of both
  stands.
