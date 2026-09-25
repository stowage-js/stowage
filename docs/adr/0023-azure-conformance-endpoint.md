# The Azure adapter runs the suite under an access token, against Azurite per commit and a real account on a schedule

ADR 0012 carries over to Azure Blob as a rule and not as a setup: an emulator every commit runs
against, a real endpoint of the promised provider in the `slow` tier, a divergence admissible only
where the same case runs against the real one, and no real endpoint in the pull request gate. This
records what Azure changes in that setup, and the one thing it changes in how an adapter meets the
suite.

Every conformance case runs against a storage built with `{ accessToken }`, on Azurite and on the
real account alike. ADR 0022 makes `presignPut` fail with `InvalidCredentials` under an account key
by design, while the storage still declares `presignedUrls`, so a conformance target built with
`{ accountKey }` fails `presign/put` on every run. Calling that failure expected would be the
accepted failure ADR 0006 rules out, and the suite has no way to run a case under a different
credential. The access token is the one scheme under which everything the storage declares works,
and the one the README leads with. The account key, promised as much as the token under ADR 0021,
is checked by a test of the adapter in the harness, as ADR 0006 has it for promises the suite
cannot observe: Shared Key signatures across the operations of the parity core, `presignGet` as a
service SAS, and `presignPut` refused before any request. It runs against both endpoints in the
tier of each. Running the suite under the account key instead would have left `presign/put`, and
with it reference flow 2, out of the suite on Azure.

Azurite qualifies as the emulator by every point of ADR 0012's bar, and it is the only candidate
that does. It accepts a bearer token only with `--oauth basic` and only over HTTPS, and it checks a
token's times, issuer and audience, not its signature or any role. The harness therefore starts it
over HTTPS with a self-signed certificate that `start.sh` generates on every start, and mints an
unsigned JWT for the audience `https://storage.azure.com` itself. Each runtime trusts the
certificate the way it trusts a CA of its own: `NODE_EXTRA_CA_CERTS` on Node and Bun, `DENO_CERT`
on Deno, and `tlsOptions.trustedCertificates` in `workerd.capnp`. `presign/put` and `presign/get`
then run on every commit, signed with a user delegation key that Azurite derives from a public seed.
That checks how the adapter builds and signs a SAS, and not whether Azure binds what `srh` names,
which only the real account can answer. Running the presign cases in the `slow` tier alone was the
alternative, and with the suite under an access token it would have left Azure with no per-commit
run at all.

The real account's token comes from GitHub OIDC with no secret stored. A user-assigned managed
identity carries a federated credential for the subject
`repo:stowage-js/stowage:environment:azure-blob`, and the harness's resolver asks the Actions
runtime for an OIDC token and exchanges it at the Entra token endpoint as a `client_assertion`. It
keeps the result until shortly before it expires, fetches a new one on `forceRefresh`, and the
`workerd` cell receives `ACTIONS_ID_TOKEN_REQUEST_URL` and `ACTIONS_ID_TOKEN_REQUEST_TOKEN` as
bindings to do the same. A setup step taking one token would have raced the job's timeout against
an Entra token lifetime of 60 to 90 minutes, and a client secret would be a long-lived credential in
the environment when a federated one serves.

## Consequences

- `harness/azure-blob/` holds `compose.yml`, `start.sh` and `stop.sh`, after `harness/s3/`. The
  image is `mcr.microsoft.com/azure-storage/azurite:3.37.0` pinned by the digest
  `sha256:830430c1da1a2d537e08f3e6764dd1f5ae00cf0346bcaf625b968ec3f0971fd5`, running the blob
  service alone, in memory, with `--oauth basic`, in strict mode without `--loose`, and without
  `--skipApiVersionCheck`. The pinned `x-ms-version: 2026-04-06` sits below Azurite's baseline of
  `2026-06-06`, so the version check stays live. `start.sh` creates the container and prints the
  environment, and `pnpm test` fails without a Docker daemon, as the S3 tier does.
- The real account is a general-purpose v2 account with `Standard_LRS` and no hierarchical
  namespace, `stowageconformance` in `swedencentral`, the region nearest the AWS bucket in
  `eu-north-1`. Its one container is `stowage-conformance`. `AllowSharedKeyAccess` is set to
  `true` explicitly, since the account key is promised and its test has to run. Anonymous access is
  off, TLS 1.2 is the minimum, and soft delete and versioning stay off, as out of scope for v0.2 and
  billed if on. The subscription carries a budget alert.
- A lifecycle management rule deletes a blob one day after its last modification, which is what
  ADR 0012's one-day rule becomes on Azure. There is no rule for uncommitted blocks, since Azure
  offers none: it discards them seven days after the last `Put Block` without a commit, and that is
  the upper bound on what a run that died leaves behind.
- The managed identity holds Storage Blob Data Contributor at the scope of the account, which
  carries `generateUserDelegationKey` and has to be granted at the account or above.
  `createStorageWithDeniedCredentials` uses a second managed identity, federated the same way,
  holding Storage Blob Data Reader alone, and expects `AuthorizationPermissionMismatch` as
  `AccessDenied`. `createStorageWithBadCredentials` hands over a token that is not a JWT, which
  costs one refresh and ends in `InvalidCredentials`. The account key is an environment secret read
  as `AZURE_STORAGE_KEY`.
- Against Azurite, `createStorageWithDeniedCredentials` is not supplied, because Azurite checks no
  role, and the `AccessDenied` case reports itself skipped with that reason. The bad credential is
  a JWT for a foreign audience. What code Azurite answers for it is for the first run to show, and
  a code other than the service's goes on the divergence list, where the same case against the
  real account settles it.
- The divergence list starts empty, as ADR 0012's did. The differences issue 108 measured, the
  error code for a bad signature, the missing clock check, the missing `x-ms-version` check, the
  `localeCompare` order of canonical headers, the range at the end of a blob, the overrides on
  unsigned requests and the unenforced size limits, reach it one by one as a conformance case shows
  them.
- After the Azure workflow and `harness/azure-blob/` are implemented, `conformance-full.yml` is
  planned to add `azure-blob` as a provider and an environment restricted to `main`. The real-account
  coverage would then run on a schedule, on demand and for the release gate, never for a pull request;
  Azurite coverage would provide the remaining runtime coverage. The final runtime matrix is still to
  be decided.
- The account holds one CORS rule, for the origin `https://conformance.stowage.invalid`, with `GET`
  and `PUT` and the headers `content-type` and `x-ms-blob-type`. A test in the `slow` tier sends a
  preflight from that origin and a `PUT` to an expired presigned URL, which settles the question
  ADR 0022 left for the first run: whether Azure sends CORS headers on that `403`.
- The same test of the adapter asserts the three response overrides of ADR 0022 against the real
  account, because Azurite applies them to any `GET`.
- Nothing here creates the account. Provisioning it, with both identities, their roles, the
  lifecycle rule, the CORS rule and the GitHub environment, is work done by hand once, before the
  real account can settle whether `srh` binds `Content-Type` and `Content-Length`.
