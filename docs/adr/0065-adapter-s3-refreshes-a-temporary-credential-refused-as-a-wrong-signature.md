# `adapter-s3` refreshes a temporary credential refused as a wrong signature

ADR 0045 found that R2 answers an expired temporary credential with `403 SignatureDoesNotMatch`,
the answer it gives a wrong secret, and withdrew the `Expired` promise for R2. A caller whose
cached temporary credential expired on R2 has since met `InvalidCredentials` after one attempt,
with the resolver never asked for a fresh one, where AWS's `ExpiredToken` leads to a refresh.
ADR 0045 named the refresh as the alternative and left it out because v0.4 took no addition. This
decision adds it.

Where an attempt carried a session token and the provider answers `SignatureDoesNotMatch`, a
refresh follows: the resolver is called with `{ forceRefresh: true }` and the request is signed and
sent once more, without a delay, on the budget ADR 0013 keeps for the refresh after `Expired`, which
`retry: false` does not switch off. Where the fresh credential is refused too, the failure is
`InvalidCredentials` with `attempts: 2`, and its message says "The temporary credential expired or
is not accepted, and so is the one the resolver refreshed", followed by the provider's message, as
`adapter-azure-blob` words it for an access token. A credential without a session token keeps the
single attempt: a refused key pair is most likely a wrong one, and no measurement shows one that
expired. The refresh after `Expired` stays with every credential, as spec 7.3 promises.

The rule is provider-blind (ADR 0014), so it holds on AWS as well. AWS answers an expired session
token with `ExpiredToken`, so a `SignatureDoesNotMatch` under one there means a wrong secret, and
that now costs two requests instead of one. So does a compatible endpoint whose signature check
disagrees with the adapter's for some key. This is the price `adapter-azure-blob` and `adapter-gcs`
already pay for a forged token: nothing in R2's answer tells an expired credential from a wrong
one, and the session token is the one sign that the credential can expire at all.
`InvalidAccessKeyId` and R2's `401 Unauthorized` are not refreshed. They name a key the provider
does not know, and the probe of ADR 0045 saw an expired temporary credential arrive as
`SignatureDoesNotMatch` alone.

The reading of a refusal learns that the attempt carried a session token from the headers the
attempt sent, by `x-amz-security-token` among them. Marking an attempt refreshable only where it
carried a session token was the alternative, and it would take the refresh after `Expired` from a
key pair. `sendRequest` is not part of the spec (ADR 0057), so what it hands the reading may change
in this minor.

`stat` and `exists` get no refresh from this. Their `HEAD` is answered `403` without a body, so no
provider code arrives, and spec 7.9 reads the status as `AccessDenied`. That is already so for
AWS's `ExpiredToken`. A `GET` of the same key with `Range: bytes=0-0` after the `403`, as ADR 0043
reads a `404`, and a refresh after every `403` to `HEAD` under a session token were the
alternatives; both cost a denied key a second request, and #414 holds them.

A unit test against a stubbed `fetch` asserts the refresh, as ADR 0021 and ADR 0033 do: one
`SignatureDoesNotMatch` under a session token, one resolver call with `forceRefresh: true`, then
success, or `InvalidCredentials` with `attempts: 2` after a second one; and one attempt for the same
answer to a key pair. No case of the scheduled run provokes it. R2's answer was measured for ADR
0045, and that ADR refused a job step that mints an expired credential on every run for the same
reason that holds here: its only likely change, towards `ExpiredRequest`, the table already reads
as `Expired`, which refreshes as well. Nothing joins spec section 18. A case that shows the refresh
recovering on every provider is #415.

## Consequences

- The spec 7.2 row on an expired credential says that R2 answers it with `403
SignatureDoesNotMatch`, that under a session token a refresh follows, and that a fresh credential
  refused too is `InvalidCredentials` with `attempts: 2`.
- Spec 7.3 names both conditions for the refresh, and that `stat` and `exists` get none.
- `CONTEXT.md` names the further attempt a refresh. Spec 7.5, 8.5 and 9.5 say "refresh" where they
  said "the `Expired` repeat"; one request still costs at most six HTTP requests.
- Spec 14.4 lists the stubbed test beside the ones for Azure and GCS.
- `errors/expired-credentials` stays skipped against R2: it asserts `Expired`, and R2 now answers
  `InvalidCredentials` with `attempts: 2`. `harness/s3/README.md` gives that reason. A wrong secret
  in the harness's `createStorageWithBadCredentials` carries no session token and keeps one attempt,
  which `errors/bad-credentials` admits as it admits two.
- A resolver that hands out R2's temporary credentials no longer has to renew them before their
  `exp` to keep a request from failing; renewing ahead still saves the refused attempt.
- It replaces the paragraph of ADR 0045 that weighed the refresh and that ADR's consequence for the
  spec 7.2 row. The rest of ADR 0045 stands.
- The change adds behavior and withdraws nothing, so ADR 0017 makes it a minor, and its changeset
  does not start with `**Breaking:**`.
