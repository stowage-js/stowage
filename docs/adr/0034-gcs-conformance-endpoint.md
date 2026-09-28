# The GCS adapter runs the suite against fake-gcs-server per commit and a real bucket on a schedule

ADR 0012 carries over to Google Cloud Storage as it did to Azure Blob in ADR 0023: an emulator every
commit runs against, a real bucket of the promised provider in the `slow` tier, a divergence
admissible only where the same case runs against the real bucket, and no real endpoint in the pull
request gate. One point of ADR 0012's bar does not carry over, and this names it as an exception
rather than letting a green run imply it.

No GCS emulator checks a credential or a signature. fake-gcs-server, storage-testbench and
gcp-storage-emulator all served a request without `Authorization`, with `Bearer not-a-token`, and
with a V4 signed URL whose signature was `deadbeef` and whose expiry passed in the year 2000
(`docs/research/gcs-emulator.md` on `research/gcs-emulator`). Google ships no emulator of its own.
ADR 0012 makes signature verification the first point of the bar, and holding GCS to it would leave
`adapter-gcs` with no per-commit run at all, since the real bucket cannot be part of the pull
request gate. fake-gcs-server 1.56.1 meets every other point on the JSON API ADR 0031 chose:
resumable uploads, paged listing with a delimiter, the batch endpoint, JSON errors with the
service's `reason`, and a `HEAD` without a body. It is the per-commit endpoint, with this exception:
the credential cases of ADR 0005 and the rejections a signed URL owes run against the real bucket
alone, and nothing that passes against fake-gcs-server says anything about them.

Presigning still runs on every commit. The conformance target for fake-gcs-server signs with an RSA
key the harness generates in Web Crypto at the start of the run, and the URLs it signs point at the
emulator. `presign/get`, `presign/put`, `presign/expires-in-bounds` and `flow/2-presigned-put` then
show that the adapter builds a URL the emulator routes to the right object with the right method and
body. Whether the signature is right is shown per commit by a test of the adapter that reproduces
Google's 40 RSA V4 vectors, which ADR 0031 already found reproducible on all four runtimes, and
against the real bucket in the `slow` tier. Declaring no signer on the emulator was the alternative;
it would have left every presigning case and reference flow 2 out of the per-commit run on GCS.

The real bucket's token comes from GitHub OIDC with no secret stored, through workload identity
federation and the impersonation of a service account. The harness's resolver asks the Actions
runtime for an OIDC token, exchanges it at `sts.googleapis.com` for a federated token, and exchanges
that at `iamcredentials.googleapis.com` for an access token of the service account with the scope
`devstorage.read_write`, the one the README leads with, so the run shows that scope suffices. It
keeps the token until shortly before it expires, fetches a new one on `forceRefresh`, and the
`workerd` cell receives `ACTIONS_ID_TOKEN_REQUEST_URL` and `ACTIONS_ID_TOKEN_REQUEST_TOKEN` as
bindings to do the same. A setup step with `google-github-actions/auth` would have raced the job's
90-minute timeout against a one-hour token, which a project without an organization cannot extend.
A service account rather than direct resource access for the federated principal, because a
federated principal cannot sign, and `signBlob` needs a service account to sign as.

## Consequences

- `harness/gcs/` holds `compose.yml`, `start.sh` and `stop.sh`, after `harness/azure-blob/`. The
  image is `fsouza/fake-gcs-server:1.56.1` pinned by the digest
  `sha256:797ce226d62f947c009dc40246b30cfb456b8473d8241407f9d6f2c04e4d69ef`, started with
  `-backend memory -scheme http -port 4443 -public-host 127.0.0.1:<port>`, where the public host is
  the exact `host:port` the client sends, and with a healthcheck on `/_internal/healthcheck`.
  `start.sh` creates the bucket with `POST /storage/v1/b` and prints the environment. The memory
  backend is the only one the harness starts: the file system backend breaks names the service
  accepts. `pnpm test` fails without a Docker daemon, as the other endpoint tiers do.
- The macOS job does not run GCS. It exists for `adapter-fs` on APFS, and a cloud adapter promises
  nothing on macOS that it does not on Linux. The release binary of fake-gcs-server is not pinned.
- Against fake-gcs-server the target resolves the fixed token `fake-gcs-server`, and supplies
  neither `createStorageWithBadCredentials` nor `createStorageWithDeniedCredentials`: both cases
  report themselves skipped with the reason that the emulator checks no credential, as the
  `AccessDenied` case does against Azurite under ADR 0023. The `Expired` case is skipped against
  every GCS endpoint under ADR 0033.
- `presign/expired-url`, `presign/put-rejects-length` and `presign/put-rejects-type` run against
  fake-gcs-server and fail there by construction, since it serves every signed URL. The divergence
  list in `harness/gcs/` starts with these three as expected failures settled by the real bucket,
  naming the README of fake-gcs-server, which states that no signature or expiry is checked. An
  expected failure rather than an unrun case, because the run still shows that the emulator serves
  the URL the adapter built.
- The other differences the research measured reach the list one by one as a conformance case
  shows them: a resumable status query that commits the upload, a chunk offset ignored, no paging
  without `maxResults`, prefixes not counted towards `maxResults`, a `404` on a media download in
  plain text, CORS as one wildcard, and no limits enforced. Two of them shape the adapter rather
  than the list: it sends `maxResults` on every listing, and it reads a `404` without a parsable
  body by its status alone.
- `list/noncharacter-key` is left out by the GCS target on both endpoints, as `harness/targets/src/fs.ts`
  leaves it out on APFS, and it is no divergence: GCS refuses the key the case writes (ADR 0032), so
  no real endpoint runs the case that would settle an entry.
- The conformance bucket is `stowage-conformance` in the project `stowage-conformance`, beside the
  measurement bucket, which stays for spikes and the open points of spec section 14. It is regional
  in `europe-north2` with the class `STANDARD`, uniform bucket-level access, public access
  prevention enforced, soft delete at 0, versioning off and no hierarchical namespace. A lifecycle
  rule deletes an object at `age: 1`, which is ADR 0012's one-day rule on GCS. There is no rule for
  incomplete uploads: the JSON API uploads through resumable sessions, which expire a week after
  they start, and that is the upper bound on what a run that died leaves behind. The bucket holds
  the CORS rule of the measurement bucket, for the origin `https://conformance.stowage.invalid`
  with `GET`, `PUT` and `Content-Type`, which the decision on presigned URLs may widen.
- Workload identity federation has one pool and one OIDC provider for
  `https://token.actions.githubusercontent.com`, whose attribute condition admits the repository
  id `1359085380`, the owner id `325610168` and the environment `gcs` alone. The service account
  `stowage-conformance` holds `roles/storage.objectAdmin` on the bucket and Token Creator on
  itself, for `signBlob`. `createStorageWithDeniedCredentials` uses a second service account,
  `stowage-conformance-denied`, holding `roles/storage.objectViewer` on the bucket alone, and
  expects `403` as `AccessDenied`. Each grants `roles/iam.workloadIdentityUser` to the principal set
  of that environment. The GitHub environment `gcs` is restricted to `main`, like `aws-s3`, `r2`
  and `azure-blob`.
- Against the real bucket `createStorageWithBadCredentials` hands over a resolver that returns
  `not-a-google-token` on every call, `forceRefresh` included. That costs one repeat and ends in
  `InvalidCredentials` with `attempts: 2` (ADR 0033).
- A token for `signBlob` comes from the same federated token with the scope `iam`, since a storage
  token's scope does not reach `iamcredentials`. How a signer takes it is the decision on presigned
  URLs. The real bucket signs through `signBlob` alone: a local key there would be a stored secret.
- Per commit, all four runtimes run the `fast` tier against fake-gcs-server: Node in the `checks`
  job of `ci.yml`, Bun, Deno and `workerd` in `runtimes`. The jobs gain a start and a stop step and
  keep their names, so the required checks on `main` do not change. `conformance-full.yml` adds
  `gcs` as a provider: Node 24, Node 26 and `workerd` run both tiers against the real bucket, Bun
  and Deno against fake-gcs-server in the `emulators` job, the split of ADR 0026. `workerd` runs
  without the Node APIs, as it does for the other adapters.
- Three tests of the adapter in the harness run against the real bucket alone, in the `slow` tier.
  `delete` in a missing bucket rejects with `NotFound`, which pins the message ADR 0032 reads. A
  preflight from the CORS origin and a `PUT` to an expired presigned URL show whether GCS sends
  CORS headers on its `400 ExpiredToken`. And a probe of the first run takes a token early with a
  short `lifetime` and asks with it after it expired, which answers the open point of ADR 0033 on
  what an expired token returns. Whether `generateAccessToken` accepts a short lifetime is
  unverified; if it does not, that point stays open.
- storage-testbench is not an endpoint of the suite: it has no paged listing and no batch endpoint.
  Whether a test of the adapter uses its fault injection for retries or its multi-call `rewrite` is
  for the decisions on uploads, copies and provider codes. ADR 0036, ADR 0037 and ADR 0038 use
  neither.
- ADR 0037 puts `move/round-trip` and `move/missing-source` on the divergence list, since
  fake-gcs-server 1.56.1 serves no `moveTo`.
- This asks two things of the decision on presigned URLs, and ADR 0035 grants both: a signer taking a key of the caller's
  own, which signs without a request, and a configurable host for the URLs the adapter signs, as
  `endpoint` is for its requests. If that decision admits no local signer, the emulator's target
  declares no `presignedUrls`, the presigning cases leave the per-commit run on GCS, and the three
  entries above leave the list.
- Nothing here creates the bucket. Provisioning it — the bucket with its lifecycle and CORS rules,
  the pool and its provider, both service accounts and their roles, and the environment `gcs` with
  its variables — is work done by hand once, before the first scheduled run against GCS.
