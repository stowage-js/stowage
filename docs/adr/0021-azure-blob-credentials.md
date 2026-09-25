# The Azure adapter takes an account key or an access token, and acquires neither

`@stowage/adapter-azure-blob` takes one option for authentication, `credentials:
Resolvable<AzureBlobCredentials>`, and follows ADR 0007 everywhere its reasons carry over: the
option is required, the credential is resolved before every request the adapter signs and cached
nowhere, each block of a streamed `put` is signed with a freshly resolved one, and no
configuration string carries it. What differs is the form, what the adapter can learn from a
refusal, and what it reads from the environment.

`AzureBlobCredentials` is `{ accountKey: string } | { accessToken: string }`. The account key
signs Shared Key requests; the access token is an Entra ID bearer token that the caller's resolver
obtained, for the scope `https://storage.azure.com/.default`. Both are within reach of `fetch` and
Web Crypto on all four runtimes, as ADR 0019 found, and both are promised. They are equal in the
adapter and not in the documentation: Microsoft recommends Entra ID and discourages Shared Key on
every page that describes it, and an account with `AllowSharedKeyAccess` set to `false` refuses
Shared Key outright while it keeps accepting bearer tokens. The README therefore leads with the
access token, including the three lines that wrap an `@azure/identity` credential's `getToken` in a
resolver, and shows the account key second with Microsoft's stance beside it.

The adapter tells the two apart by which field is present. An explicit tag such as `kind:
"sharedKey"` would restate what the field already says, and two options, `accountKey` and
`accessToken`, would split ADR 0007's one required option into two optional ones held together by
a rule, and stop a resolver from changing scheme between calls. Neither is a flavor in the sense
of ADR 0014: what is told apart is the form of the credential, not the behavior of the provider.

Three schemes Azure accepts are left out. A SAS token handed in whole cannot sign a SAS of its own,
so `presign` would have nothing to sign with, and its signed permissions may be narrower than the
capabilities the storage declares, which would make ADR 0015's declarations depend on the
credential rather than the adapter. It can join the union later without taking anything from a
caller, which ADR 0017 makes a minor release. Token acquisition ships in no form. A client-secret
flow is one `fetch`; Azure Arc exposes a host-provided identity endpoint on non-Azure machines,
together with its challenge-token file, but the adapter acquires tokens from neither. Callers can
provide externally acquired tokens through the existing `accessToken` resolver. Workload identity
on Kubernetes reads a projected token file that `workerd` cannot reach: the same walls ADR 0007
met with IMDSv2 and `AssumeRoleWithWebIdentity`.
`@stowage/credentials-azure` is the named place for those resolvers, beside
`@stowage/credentials-aws`, once writing them twice becomes the common case.

Azure has no error code that means only that a credential expired. An expired access token and a
forged one both answer `401 InvalidAuthenticationInfo`, and an account key never expires. ADR 0007
repeats a request once with `{ forceRefresh: true }` after the provider answered `Expired`, and on
Azure the adapter repeats once after `401 InvalidAuthenticationInfo` under an access token instead,
the one refusal an expiry can hide behind. If the second attempt fails too, the failure is
`InvalidCredentials`, and its message says the token expired or is not accepted. The adapter never
reports `Expired`, which is a code the closed set of ADR 0005 keeps and every adapter may leave
unused, as `adapter-fs` does; what a caller relies on is that a stale token is refreshed once, and
that holds. The alternative was an optional `expiresOn` on the access token, which
`@azure/identity` hands out as `expiresOnTimestamp`, letting the adapter report a genuine `Expired`
and refresh before sending. It reverses the reason ADR 0007 gives for carrying no expiry, that
detecting it is the resolver's job, for the sake of an error name, and it can still be added in a
minor release. Parsing the message prose was never open, because it is not a provider code.

## Consequences

- The account is configuration, not credential: `account` is a required option beside the
  container, because it names the endpoint for both schemes and enters every Shared Key signature.
  Without `endpoint` the adapter addresses `https://<account>.blob.core.windows.net`. With it, the
  rules of `adapter-s3` apply: an absolute URL without userinfo, query or fragment, `https:`
  always and `http:` only on a loopback host, and a path becomes the prefix of every request path.
  Azurite's `http://127.0.0.1:10000/devstoreaccount1` then yields the canonicalized resource
  `/devstoreaccount1/devstoreaccount1/…` that the emulator expects, without a case of its own. The
  account is never read from the host, which ADR 0003 would call discovery.
- The resolved credential is checked before signing, and each violation is `InvalidCredentials`
  naming the field: both fields present, neither present, a field outside the two, an empty value,
  or an `accountKey` that does not decode as base64 to at least one byte. The access token is
  opaque and is not parsed as a JWT. A resolver may answer an account key on one call and an
  access token on the next, and each request is signed with what it resolved to.
- `403 AuthenticationFailed` is `InvalidCredentials`: a wrong key, a malformed signature or a
  clock more than 15 minutes off. It is not repeated, because a key does not expire.
- `403 KeyBasedAuthenticationNotPermitted` is `InvalidCredentials` and not repeated. The key may
  be right, but the account does not accept that form of credential, and the message points at the
  access token as the scheme that account still accepts.
- `403 AuthorizationPermissionMismatch` is `AccessDenied`: the principal is authenticated and
  lacks the role.
- The repeat after `401 InvalidAuthenticationInfo` has the budget ADR 0013 gives the `Expired`
  repeat, outside the one `retry: false` switches off. A genuinely wrong access token costs one
  request more than it would on S3.
- The `Expired` conformance case reports itself skipped against Azure, as it does against R2. A
  unit test with a fake `fetch` asserts the repeat instead: one `401` under an access token, one
  resolver call with `forceRefresh: true`, then success, or `InvalidCredentials` after a second
  `401`.
- `fromEnv` reads `AZURE_STORAGE_KEY` alone and answers `{ accountKey }`, with the guards ADR 0007
  gives the S3 one. It does not read `AZURE_STORAGE_ACCOUNT`, because the account is
  configuration and a misspelled variable would then point the storage elsewhere in silence; nor
  `AZURE_STORAGE_CONNECTION_STRING`, which is the configuration string ADR 0007 refused, and which
  the README shows split into `account`, `endpoint` and `accountKey`; nor an access token, which in
  an environment variable is a snapshot that stops working within 90 minutes.
- Two adapters now read the environment through the same guards, so the read moves into
  `@stowage/core` among the exports for adapter authors, under the rule ADR 0019 set for what two
  adapters need, and `adapter-s3` imports it from there.
- The slow tier of ADR 0012 has to exercise both schemes against the real account, since both are
  promised. How it obtains the access token is decided with the conformance endpoint.
- Which kind of SAS `presign` produces follows from the credential and is decided with presigned
  URLs: an account key can sign a service SAS, which binds no request header, and an access token
  can obtain the user delegation key that `srh` needs.
- No anonymous request is sent. A container with anonymous read access is read with `fetch`, as
  ADR 0007 has it for a public bucket.
