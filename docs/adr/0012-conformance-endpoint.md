# The conformance suite runs against SeaweedFS per commit and against S3 and R2 on a schedule

An S3-compatible endpoint qualifies for the per-commit run when it verifies SigV4 rather than
accepting any signature, implements multipart upload, serves presigned `GET` and `PUT`, answers with
the S3 error codes ADR 0005 maps, pages `ListObjectsV2` past 1000 keys with a continuation token and
a delimiter, and answers `HEAD` without a body. All six are asked of one endpoint, because one
endpoint is what every commit runs against and it therefore carries the whole suite. What a real
bucket shows beyond that is a reason to run against one as well, not a reason to ask the emulator
for less.

MinIO was the obvious answer and is gone: `minio/minio` was archived on 2026-04-25 and `dl.min.io`
answers `410 Gone` for every community download. `pgsty/silo` continues the code under a new name,
and its behavior against the six points is inherited rather than demonstrated. Three further
candidates fail the bar outright. `adobe/S3Mock` states in its own README that a presigned URL is
"accepted but not validated (expiration, signature, HTTP verb not checked)", which removes the first
point and most of the third. LocalStack stopped shipping a standalone community image in release
2026.03.0 on 2026-03-23; the free tier is now restricted to non-commercial use and requires an
account token to start, and its signature validation is off unless `S3_VALIDATE_SIGNATURES=1` is
set. Ceph's RADOS Gateway needs a cluster around it, and Ceph's own S3 compliance document is marked
a draft that might not be accurate.

SeaweedFS is chosen over the four that remain. It is the endpoint the SigV4 spike already ran
against, so its behavior on all four operations, on presigning and on the failure paths has been
seen rather than read off a table; it is released monthly under Apache-2.0, at 4.47 on 2026-09-14;
its signature comparison is in `weed/s3api/auth_signature_v4.go` rather than implied; and its
multipart is the provider's own, including `UploadPartCopy`. The alternatives each lose on one
point. `gaul/s3proxy` emulates multipart through a stub object holding the metadata, and multipart
is a v0.1 obligation whose edge cases — `EntityTooSmall`, equal part sizes — are exactly what an
emulation is most likely to get wrong. `scality/cloudserver` carries the best evidence on error
codes, which `arsenalErrors.json` defines verbatim, and no evidence at all on presigning. RustFS
reached 1.0.0 on 2026-09-16. `versitygw` states that its matrix "represents API availability, not
exact behavioral parity with AWS S3", and it is a gateway that needs a backend underneath it.

SeaweedFS is not S3 either. The spike found that its `encoding-type=url` handling and its XML
element order differ from what AWS documents. Issue 11321 closed on 2026-09-15, but the fix merged
after 4.47 and the pinned 4.47 image still returns an empty listing when `start-after` sorts before
the prefix. Three further points of the bar are
unverified for every candidate, SeaweedFS included: whether `EntityTooSmall` and `InvalidPart` are
returned as S3 returns them, whether a presigned `PUT` enforces the `Content-Length` and
`Content-Type` it signed, and whether `HEAD` is answered without a body. No data sheet settles
those. The first run of the conformance suite does.

That is why the endpoint is configuration rather than a dependency. The harness reads a URL and a
credential from the environment, and no case knows which server answers. The pinned image digest in
`compose.yml` is what CI starts and is what green means; pointing the harness at another endpoint is
a way to look, not a second definition of correct. Docker is required: `compose.yml` is started by
the script CI calls, `pnpm test` includes the S3 tier and fails when no daemon is reachable rather
than passing with the tier skipped. The macOS job runs the `adapter-fs` cells alone, because
GitHub's macOS runners have no Docker.

Against an emulator alone, no adapter would ever be checked against the thing it claims to support.
`conformance-full.yml` therefore runs the `slow` tier against a real AWS S3 bucket and a real R2
bucket as well, on Node and on `workerd`. Those two are the pair that differ most in how they fetch,
and the emulator answers plain HTTP on `127.0.0.1` with no TLS, no latency and no redirect, so the
runtimes that talk to a real endpoint are the ones where that gap can show. Bun and Deno run against
the emulator. ADR 0002 counts a cell as supported where the suite covers it in CI, and the suite is
the same one in every cell; what differs is what answered it, and the runtime matrix in the spec
carries that as a note rather than as a support level of its own.

A divergence between the emulator and AWS cannot become an accepted failure, which ADR 0006 rules
out, and it cannot be ignored either. `harness/` holds a list of divergences, one entry per
conformance case, naming the endpoint, what it does differently, and the real endpoint that runs
the same case in the `slow` tier. The harness expects those cases to fail for that one target. An
entry that passes unexpectedly fails CI, so an upstream fix reaches the list at the next image
update instead of going unnoticed. An entry is admissible only where the same case runs against a
real endpoint, which is what keeps the list from becoming the thing ADR 0006 forbids. It stays in
the private harness and is never part of `@stowage/conformance`, because it describes one endpoint
this repository happens to test against and nothing about the API a third-party adapter implements.

## Consequences

- A capability the endpoint lacks disqualifies it; a behavior it gets wrong goes on the divergence
  list. An endpoint without multipart or without presigning would leave reference flow 1 and
  reference flow 2 unchecked per commit, which is half of what v0.1 promises.
- The list starts with the two divergences the spike found and the one closed SeaweedFS issue whose
  divergence the pinned image still exhibits. Each entry names the upstream issue where one exists,
  so the next person to read it can tell a bug that is being fixed from a difference that is
  intended.
- The CI bucket at each provider holds nothing else and carries a lifecycle rule that expires
  objects after one day and aborts incomplete multipart uploads after one day. ADR 0006 gives each
  run its own `keyPrefix` and a `cleanup()` that deletes below it; the lifecycle rule is what
  removes the parts of a run that died before its cleanup, which is the case ADR 0006 moved out of
  the suite and into this repository.
- GitHub passes no secret other than `GITHUB_TOKEN` to a workflow triggered by a pull request from a
  fork, so the real endpoints cannot be part of the pull request gate. `conformance-full.yml` runs
  on a schedule, on demand and before a release, and never on `pull_request`.
- Each credential is scoped to its own bucket, and the AWS account carries a budget alarm. R2's free
  tier covers the suite at 10 GB-month, one million class A operations and ten million class B
  operations. AWS has no perpetual free tier for an account created after 2025-07-15, and the suite
  costs cents per month at $0.005 per thousand `PUT` requests.
- ADR 0007 asks this decision for a short-lived STS token, because an expired credential cannot be
  invented. A dedicated setup step in `conformance-full.yml` requests one with the 900-second
  minimum AWS allows, records the expiration returned by STS, and waits until that time plus a fixed
  safety margin has passed before `createStorageWithExpiredCredentials` can supply it. The
  `Expired` case therefore always starts with an already-expired credential instead of relying on
  the duration of the rest of the suite. The factory is supplied for AWS alone; against R2 the case
  reports itself skipped with its reason, and `Expired` stays a code that v0.1 has observed against
  S3 and not against R2.
- Since wrangler 4.115.0, released 2026-07-28, `local_dev.experimental_s3_credentials` serves a
  local R2 bucket over a SigV4-authenticated S3 API. A second emulator is not worth two start paths
  and two digests while the field carries its `experimental` prefix, and while what the parity core
  promises on R2 is still open. When the prefix goes, this is worth deciding again.
