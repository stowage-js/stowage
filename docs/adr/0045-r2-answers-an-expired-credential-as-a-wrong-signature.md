# R2 answers an expired credential as a wrong signature, and the `Expired` promise is withdrawn

ADR 0014 mapped R2's `ExpiredRequest` to `Expired` from R2's documentation alone and marked it
provisional, and ADR 0028 left it as the one promise of spec section 14 that no run could provoke,
since R2 seemed to issue no credential that could be let expire on purpose. It does: Cloudflare
documents temporary credentials that a caller signs locally, as an HS256 JWT keyed with the parent
token's secret access key, whose `exp` the signer writes. So a credential can be minted already
expired from nothing the scheduled run does not hold.

The probe of the research note on `research/r2-expired-request` was run on 2026-09-30 on Node 24
with `adapter-s3` 0.3.0 against the R2 bucket of the scheduled run, the parent being the token that
may read that bucket alone. A temporary credential valid for fifteen minutes read a missing key as
`404 NoSuchKey`, so R2 accepts local signing with that parent. One minted with `exp` five minutes
in the past, and one that lived for five seconds and was sent a minute later, were both answered
`403 SignatureDoesNotMatch`, the same answer as a JWT keyed with a secret that is not the parent's.
`adapter-s3` reads that as `InvalidCredentials` after one attempt. `ExpiredRequest` did turn up,
at `403` with the message "Request has expired", as the answer to a presigned URL fetched after it
expired, which the adapter never fetches itself. A request whose `X-Amz-Date` lay twenty minutes
back was answered `403 RequestTimeTooSkewed`, which the table maps to `InvalidRequest`, so a
drifting clock does not reach `ExpiredRequest` either.

The promise is disproved, and ADR 0028 has a disproved promise withdrawn rather than held open. On
R2 an expired credential is `InvalidCredentials` with `attempts: 1`, told apart from a wrong secret
by nothing in the answer. The resolver is never called with `forceRefresh: true` for it, since the
adapter never sees `Expired` from R2. A resolver that hands out R2's temporary credentials renews
them before their `exp`. The adapter's code already does all of this, so only the spec changes.

A repeat under `forceRefresh` for a credential carrying a `sessionToken` that the provider refuses
as `SignatureDoesNotMatch` was the alternative, the rule `adapter-azure-blob` follows for a `401`
under an access token. It stays provider-blind (ADR 0014), and `errors/bad-credentials` already
admits two attempts. But it adds a behavior, which v0.4 does not take, and adding it later is a
minor that withdraws nothing, whereas the promise it would replace has to leave now.

`ExpiredRequest` stays in the code table as `Expired`, no longer provisional. R2 was seen sending
it, so it meets ADR 0041's bar for a string in the table, and should R2 ever answer an expired
credential with it, `Expired` is the right name. Striking it would send it to the status mapping,
where a `403` is `AccessDenied`, the one answer that tells the caller the credential was fine.

The `Expired` case stays skipped against R2, now because it cannot pass there rather than because
nothing provokes it. A job step or harness code that signs an expired credential for a probe of
`SignatureDoesNotMatch` on every scheduled run was the alternative. It would guard an answer whose
only likely change, towards `ExpiredRequest`, the table already reads correctly.

## Consequences

- Spec 7.2 gains a row: R2 answers an expired credential, including a temporary credential past its
  `exp`, with `403 SignatureDoesNotMatch`, which is `InvalidCredentials` with `attempts: 1`, and
  the resolver is not called again with `forceRefresh: true` for it.
- The spec 7.9 note on `ExpiredRequest` loses "provisional" and says that R2 sends it for an
  expired presigned URL and not for an expired credential.
- The promise leaves spec section 14. With ADR 0042 taking `raw` out of the gate, the list of
  promises there is empty, and what section 11 then says about 1.0 is for the v0.4 spec to write.
- `harness/s3/README.md` gives the new reason for the skip, and the entry for the promise leaves
  `harness/s3/src/first-run.ts`. The `STOWAGE_S3_EXPIRED_*` variables stay as AWS uses them.
- This narrows what the spec promised for a released adapter, which is a conflict with ADR 0017's
  rule that a withdrawal takes something from the caller. `adapter-s3` withdraws `Expired` and the
  `forceRefresh` repeat for an expired credential on R2. The change is a minor below 1.0, and its
  changeset starts with `**Breaking:**`, although no code changes.
- It replaces ADR 0014's statements that R2's `ExpiredRequest` is provisional and awaits a run, and
  ADR 0028's example of R2's `ExpiredRequest` as the promise that may have to be withdrawn. The rest
  of both stands.
