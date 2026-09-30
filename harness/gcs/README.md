# The GCS endpoint the conformance suite runs against

ADR 0034 picked fake-gcs-server: it serves the JSON API ADR 0031 chose, with resumable uploads,
paged listing with a delimiter, the batch endpoint, JSON errors carrying the service's `reason` and
a `HEAD` without a body. `compose.yml` pins the image by digest, and that digest is what CI starts
and what green means. It runs with the memory backend alone, since the file system backend breaks
names the service accepts.

No GCS emulator checks a credential or a signature, which is the exception ADR 0034 makes to ADR
0012: the credential cases and the rejections a signed URL owes run against the real bucket alone,
and nothing that passes here says anything about them.

## Running the suite against it

```sh
eval "$(./harness/gcs/start.sh)"
pnpm test
./harness/gcs/stop.sh
```

`pnpm test` runs the Node column of spec 2, the S3 and Azure Blob tiers included, so
`harness/s3/start.sh` and `harness/azure-blob/start.sh` belong beside it. `pnpm test:bun`,
`pnpm test:deno` and `pnpm test:workerd` run the same tier in the other three columns, against the
same endpoint. Docker and `curl` are required. Without `STOWAGE_GCS_ENDPOINT` and
`STOWAGE_GCS_BUCKET` the run fails rather than passing with the tier skipped (ADR 0012), and CI
starts `compose.yml` itself before the harnesses run. A machine without Docker sets
`STOWAGE_CONFORMANCE_ENDPOINTS` to `none`, as `harness/s3/README.md` describes.

fake-gcs-server listens on `127.0.0.1:4443`. Where that port is taken, `STOWAGE_GCS_PORT` names
another one, and both the printed endpoint and the emulator's `-public-host` follow it.

`start.sh` recreates the container, which starts empty, creates the bucket the suite writes to and
prints the environment the run reads:

| Variable                    | What it names                                                    |
| --------------------------- | ---------------------------------------------------------------- |
| `STOWAGE_GCS_ENDPOINT_NAME` | `fake-gcs-server`, which selects the divergences the run expects |
| `STOWAGE_GCS_ENDPOINT`      | The URL the adapter is constructed against                       |
| `STOWAGE_GCS_BUCKET`        | The bucket the run writes below its own prefix in                |

## The credential

Against fake-gcs-server every case runs under the fixed token `fake-gcs-server`, which the
adapter sends as the bearer of every request and the emulator never reads. The target supplies neither
`createStorageWithBadCredentials` nor `createStorageWithDeniedCredentials`, so both cases report
themselves skipped, and the `Expired` case is skipped against every GCS endpoint (ADR 0033).

There the storage signs its URLs with a `privateKey`: an RSA `CryptoKey` the target generates in Web
Crypto once per run, on every runtime, under a service account that does not exist. The URLs point
at the emulator, so `presign/get`, `presign/put`, `presign/expires-in-bounds` and
`flow/2-presigned-put` show that it serves the object the adapter addressed, with the method and
body the URL grants. Whether the signature is right is shown by Google's V4 vectors in the adapter's
own tests and by the real bucket (ADR 0034, ADR 0035).

## The real bucket

`.github/workflows/conformance-full.yml` runs both tiers on a schedule, on demand and for a
release workflow to call: on Node 24, Node 26 and `workerd` against the bucket, and on Bun and
Deno against fake-gcs-server (ADR 0039). Its jobs set `STOWAGE_CONFORMANCE_ENDPOINTS` to `gcs`, so
that the other tiers' endpoint checks stay out of their run.

The bucket is `stowage-conformance` in the project `stowage-conformance`, regional in
`europe-north2`. The GitHub environment `gcs`, restricted to `main`, holds no secret:

| Variable                                 | What it holds                                                                                             |
| ---------------------------------------- | --------------------------------------------------------------------------------------------------------- |
| `STOWAGE_GCS_BUCKET`                     | The bucket, `stowage-conformance`, which holds nothing else                                               |
| `STOWAGE_GCS_WORKLOAD_IDENTITY_PROVIDER` | The provider as `projects/<number>/locations/global/workloadIdentityPools/<pool>/providers/<provider>`    |
| `STOWAGE_GCS_SERVICE_ACCOUNT`            | The email of `stowage-conformance`, `roles/storage.objectAdmin` on the bucket and Token Creator on itself |
| `STOWAGE_GCS_DENIED_SERVICE_ACCOUNT`     | The email of `stowage-conformance-denied`, `roles/storage.objectViewer` on the bucket alone               |

The job sets `STOWAGE_GCS_ENDPOINT_NAME` to `gcs` and no `STOWAGE_GCS_ENDPOINT`, so the adapter
addresses `https://storage.googleapis.com` as a caller in the public cloud does, and the divergence
list does not apply.

The job holds `id-token: write`, and `src/federated-token.ts` asks the Actions runtime for an OIDC
token with the audience `https://iam.googleapis.com/<provider>`, exchanges it at
`https://sts.googleapis.com/v1/token` for a federated token, and that at
`iamcredentials.googleapis.com` for a token of the service account (ADR 0034). The suite runs
under the scope `devstorage.read_write`, and the storage signs its URLs through `signBlob` as the
same service account, under a token with the scope `iam` from the same federated token. Each
token is kept until five minutes before it expires and fetched again on `forceRefresh`. The pool's
attribute condition admits the repository, its owner and the environment `gcs` alone, so a job
in another environment is refused at STS. On `workerd` the bindings of `workerd.capnp` carry the
provider, both service accounts, `ACTIONS_ID_TOKEN_REQUEST_URL` and
`ACTIONS_ID_TOKEN_REQUEST_TOKEN`, and the worker does the same exchanges.

`createStorageWithDeniedCredentials` runs under `stowage-conformance-denied`, which the bucket
answers with `403` on a write, and `errors/denied-credentials` reads that as `AccessDenied`.
`createStorageWithBadCredentials` hands over a resolver that answers `not-a-google-token` on every
call, `forceRefresh` included, which ends in `InvalidCredentials` after the one repeat (ADR 0033).
Against fake-gcs-server the target supplies neither.

A lifecycle rule deletes an object a day after it was written, which removes what a run that died
before its cleanup left, and a resumable session a run left open expires a week after it started.
The one CORS rule is what flow 2 needs from a page: the origin
`https://conformance.stowage.invalid`, the methods `GET` and `PUT`, and the header
`content-type`.

## Settled by the first run

Two files ask the bucket what fake-gcs-server cannot answer, and run only where
`STOWAGE_CONFORMANCE_INCLUDE_SLOW` is `true` and `STOWAGE_GCS_ENDPOINT_NAME` is `gcs`, on Node 24
and Node 26.

`src/adapter-gcs.test.ts` holds the promises of spec 10.4 the suite does not assert: the two
response overrides of `presignGet`, the CORS headers on the `400 ExpiredToken` for an expired
presigned URL after a preflight from the rule's origin, `delete` in a missing bucket rejecting with
`NotFound` without `key` and `exists` rethrowing it, and URLs signed through `signBlob` for a key
that travels encoded.

`src/first-run.test.ts` asks what spec 14 left open for GCS, and keeps asking it once the first run
settled it. It takes a token of the service account with a `lifetime` of 60 seconds from IAM
Credentials, waits out its expiry, and records what the bucket answers it, then shows that the
repeat of spec 9.3 recovers. Where IAM Credentials grants no such token, the probe records the
refusal and skips itself. It also replaces an object and records what `objects.get` pinned to the
replaced generation answers, on the resource and the media download. The `workerd` harness runs
`flow/1-large-upload` once more on its own against the bucket and reports its duration and the CPU
the `workerd` process spent, the token exchanges included.

The last job of the workflow writes the points into the same table as the S3 and Azure ones, in
the columns `gcs-node-24`, `gcs-node-26` and `gcs-workerd`.

## The `workerd` harness

The worker runs the tier under `no_nodejs_compat` and `no_nodejs_compat_v2`, where no Node API is
reachable, and runs its `fast` cases a second time under the default flags of the compatibility
date (ADR 0026, ADR 0039). fake-gcs-server answers over plain HTTP, so no runtime has a certificate
to trust.

## The cases run so far

The adapter gains its operations one ticket at a time, and `src/target.ts` names the cases it
passes. A case joins that list with the operation it needs, until the list is the whole suite.
Every column takes the case list and the divergence list of `src/divergences.ts` from here, so a
case that joins `src/target.ts` runs on Node, Bun, Deno and `workerd` alike.

`list/noncharacter-key` stays out on every GCS endpoint, since GCS refuses the key the case writes
(spec 10.7, ADR 0034).

## The divergence list

`src/divergences.ts` holds one entry per conformance case fake-gcs-server answers differently from
the real bucket (ADR 0012, ADR 0034), and applies where `STOWAGE_GCS_ENDPOINT_NAME` names
fake-gcs-server alone. The mechanism is the S3 harness's: against the endpoint an entry names, the
case passes where it fails as the entry says and fails where it passes. `flow/3-file-browser` is on it because the emulator counts only the objects
of a page towards `maxResults`, where GCS counts the pseudo-directories as well, so the level the
flow lists arrives as one page without a cursor. `presign/expired-url`, `presign/put-rejects-length`
and `presign/put-rejects-type` are on it because the emulator checks neither the signature nor the
expiry of a signed URL, as its README states, so it serves the URL each case expects refused.
`move/round-trip` and `move/missing-source` are on it because the emulator serves no `objects.move`
and answers every `moveTo` with `400 invalid`, the source left where it was (ADR 0037).
`list/noncharacter-key` is not on it: no real endpoint runs the case to settle an entry.
