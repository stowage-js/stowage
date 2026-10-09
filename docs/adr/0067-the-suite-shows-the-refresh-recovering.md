# The suite shows the refresh recovering

Every cloud adapter refreshes once after the provider refused a credential that a fresh one may
pass: `adapter-s3` after `Expired`, and after `SignatureDoesNotMatch` under a session token (ADR
0065); `adapter-azure-blob` after `401 InvalidAuthenticationInfo` under an access token (ADR 0021);
`adapter-gcs` after `401` with `error=invalid_token` (ADR 0033). Until now the suite showed none of
it. `errors/expired-credentials` runs against AWS alone and asserts the failure that follows a
second refusal, and the recovery was asserted against a stubbed `fetch` and, on GCS, by one probe
outside the suite. ADR 0065 left a case for the recovery to #415, and this decision adds it.

`errors/stale-credentials` takes a storage from a new optional factory,
`createStorageWithStaleCredentials(onRefresh)`, for each of `get`, `stat` and a `put` of bytes in
hand, and asserts that each operation succeeds and that the storage's resolver was asked with
`forceRefresh: true` exactly once. The resolver answers the stale credential until it is asked to
refresh, and the fresh one from then on, under `forceRefresh: false` too, because a recovered `stat`
on S3 resolves again for its second `HEAD` (ADR 0066) and would meet the stale credential from a
resolver that answers by the option alone. It calls `onRefresh` on each refresh. Each operation gets
a storage of its own, since a storage that refreshed holds the fresh credential for whatever it
sends next.

Asserting the success alone was the alternative. It passes against an endpoint that checks no
credential, and against a harness whose stale credential the provider happens to accept, and in
both cases shows nothing. The resolver is the caller's own, so how often it was asked to refresh is
something a caller observes, and the suite still asserts nothing below the API. Asserting the whole
sequence of `forceRefresh` values, as the GCS probe of `first-run.test.ts` does, was rejected: the
sequence depends on how many requests an operation sends, which on S3's `stat` is the follow-up
`GET` of ADR 0066. Handing the count back beside the storage was the other way to observe it; a
callback keeps the factory returning a storage as its siblings do. "Exactly once" rules out an
adapter that refreshes on every request as well as one that never does.

The case is `fast`. What it spends is three operations; what a target spends to obtain a stale
credential before its factory returns, such as waiting out a token, is not the case's cost, and
spec 14.2 now says so. `errors/expired-credentials` stays `slow` and unchanged: it shows the second
refusal, this case the recovery.

Where the stale credential comes from was measured on 2026-10-09:

- On AWS a made-up session token beside the configured key pair is answered `400 InvalidToken`, on
  R2 `400 InvalidArgument` with the message `X-Amz-Security-Token`, for every token shape tried.
  Neither refreshes, so a made-up token cannot stand in on S3 (#418 holds the reading of
  `InvalidToken`). AWS hands over the STS token that `errors/expired-credentials` already waits out,
  so the run waits once for both cases.
- R2 refuses a temporary credential that the harness signs from the configured key pair, with an
  `exp` five minutes before the signing, as `SignatureDoesNotMatch` under a session token, and a
  refresh to the key pair recovers `get` and `stat`. A credential scoped `object-read-only` is
  refused a `put` as `AccessDenied` before R2 looks at its expiry, which does not refresh, so the
  harness signs it `object-read-write`. The signing is Web Crypto, so `workerd` runs it too.
- Azure answers a token that is not a JWT with `401 InvalidAuthenticationInfo`, which refreshes as
  an expired token does, and GCS answers a made-up token as it answers one past its expiry (ADR
  0033). Both hand over a made-up token as the stale credential and the configured one as the fresh
  credential.
- Azurite 3.37.0 answers a token that is not a JWT, and an unsigned JWT past its `exp`, with
  `403 AuthenticationFailed`, which does not refresh: `get` ends in `InvalidCredentials` with
  `attempts: 1`. `errors/bad-credentials` cannot tell, since both answers read as
  `InvalidCredentials` and it admits one or two attempts. Azurite gets the factory, and the case
  fails there as a divergence that the run against the account settles.
- fake-gcs-server and SeaweedFS check no temporary credential and supply no factory, so the case
  reports itself skipped there.

Minting R2's credential through the Cloudflare API in a job step, and waiting for its `exp`, was the
first plan. It needs a Cloudflare API token as a secret of the `r2` environment, far stronger than
the bucket-scoped token the environment holds, and a wait of its own. ADR 0045 rejected harness
code that signs an expired R2 credential on every scheduled run, because it would only guard an
answer whose likely change the table already reads. That reasoning does not reach this case: the
signed credential is what lets the run show R2's recovery at all, and the answer it guards is the
refresh of ADR 0065, which a change of R2's answer would silently take away.

## Consequences

- `ConformanceTarget` gains `createStorageWithStaleCredentials`, and `ConformanceFactoryName` gains
  its name. Spec 14.1 and 14.3 describe it, spec 14.5 lists `errors/stale-credentials`, and spec
  14.2 says that a case's cost leaves out what a target spends to obtain a credential.
- The stubbed adapter tests that spec 14.4 lists for the refresh stay. They show what no endpoint
  provokes on purpose: the second refusal and its `attempts: 2`, and one attempt for a key pair.
- `harness/targets/src/stale-credentials.ts` holds the resolver all three harnesses share. The S3
  harness signs R2's credential in `harness/s3/src/r2-temporary-credential.ts`, after the research
  note on `research/r2-expired-request`. No workflow step, variable or secret is added.
- `harness/azure-blob/src/divergences.ts` lists Azurite's answer against `errors/stale-credentials`.
  ADR 0023's statement that the bad token "costs one refresh and ends in `InvalidCredentials` with
  `attempts: 2`" holds for the account alone.
- It replaces the paragraph of ADR 0045 that rejected harness code signing an expired R2
  credential, and fulfils the last sentence of ADR 0065's paragraph on its tests. The rest of both
  stands.
- The case is skipped where a target leaves the factory out, so a third-party adapter passes as
  before. ADR 0017 makes the change a minor, and its changeset does not start with `**Breaking:**`.
