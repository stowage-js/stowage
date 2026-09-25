# The S3 endpoint the conformance suite runs against

ADR 0012 picked SeaweedFS: it verifies SigV4, implements multipart upload, serves
presigned `GET` and `PUT`, answers with the S3 error codes, pages `ListObjectsV2` past
1000 keys and answers `HEAD` without a body. `compose.yml` pins the image by digest, and
that digest is what CI starts and what green means. Pointing the run at another endpoint
is a way to look, not a second definition of correct.

## Running the suite against it

```sh
eval "$(./harness/s3/start.sh)"
pnpm test
pnpm test:workerd
pnpm test:bun
pnpm test:deno
./harness/s3/stop.sh
```

`pnpm test` runs the Node column of spec 2. `pnpm test:workerd` starts the `workerd` that
`harness/workerd` pins and reports its results on Node. Bun and Deno are not dependencies:
`pnpm test:bun` and `pnpm test:deno` need them installed, in the versions `.bun-version`
and `.dvmrc` pin for CI.

`start.sh` starts the container, creates the bucket and prints the environment the run
reads:

| Variable                      | What it names                                          |
| ----------------------------- | ------------------------------------------------------ |
| `STOWAGE_S3_ENDPOINT`         | The URL the adapter is constructed against             |
| `STOWAGE_S3_BUCKET`           | The bucket the run writes below its own prefix in      |
| `STOWAGE_S3_REGION`           | The region, sent as configured                         |
| `STOWAGE_S3_FORCE_PATH_STYLE` | `true` for the emulator, which resolves no bucket host |
| `AWS_ACCESS_KEY_ID`           | Read by `fromEnv`                                      |
| `AWS_SECRET_ACCESS_KEY`       | Read by `fromEnv`                                      |

The credential the provider accepts and refuses a write to, which spec 9.3 asks a target
for, is the second identity of `s3.json` and reaches the run through two more variables.
Without them the case that needs it reports as skipped.

| Variable                              | What it names                                      |
| ------------------------------------- | -------------------------------------------------- |
| `STOWAGE_S3_DENIED_ACCESS_KEY_ID`     | An identity that reads and lists and may not write |
| `STOWAGE_S3_DENIED_SECRET_ACCESS_KEY` | Its secret                                         |

Docker is required. Without `STOWAGE_S3_ENDPOINT` the run fails rather than passing with
the tier skipped (ADR 0012), and CI starts `compose.yml` itself before the harnesses run.

The credentials in `s3.json` are this container's and nothing else's: they authenticate a
local emulator holding a run's throwaway objects.

`start.sh` names the endpoint `seaweedfs` in `STOWAGE_S3_ENDPOINT_NAME`, which is what the
divergence list below is read against.

## The divergence list

`src/divergences.ts` holds one entry per conformance case the emulator answers differently
from AWS S3 (ADR 0012): the case, the endpoint, what differs, part of the message the case
fails with, and the real endpoint that runs the same case in the `slow` tier. Against the
endpoint an entry names, the case passes where it fails as the entry says and fails where
it passes, so an upstream fix shows up as a red run that asks for the entry to go.

## The real endpoints

`.github/workflows/conformance-full.yml` runs both tiers on a schedule, on demand and for a
release workflow to call: on Node 24, Node 26 and `workerd` against a real AWS S3 bucket and a
real R2 bucket, and on Bun and Deno against the emulator. It never runs on a pull request.

Each provider is a GitHub environment, `aws-s3` and `r2`, holding the same names:

| Name                                  | Kind     | What it holds                                                                           |
| ------------------------------------- | -------- | --------------------------------------------------------------------------------------- |
| `STOWAGE_S3_ENDPOINT`                 | variable | `https://s3.<region>.amazonaws.com`, or `https://<account-id>.r2.cloudflarestorage.com` |
| `STOWAGE_S3_BUCKET`                   | variable | The CI bucket, which holds nothing else                                                 |
| `STOWAGE_S3_REGION`                   | variable | The bucket's region, `auto` on R2                                                       |
| `STOWAGE_S3_ACCESS_KEY_ID`            | secret   | A credential that reads, writes, lists and deletes in that bucket alone                 |
| `STOWAGE_S3_SECRET_ACCESS_KEY`        | secret   | Its secret                                                                              |
| `STOWAGE_S3_DENIED_ACCESS_KEY_ID`     | secret   | A credential that reads and lists that bucket and may not write                         |
| `STOWAGE_S3_DENIED_SECRET_ACCESS_KEY` | secret   | Its secret                                                                              |

On AWS the first credential is an IAM user's access key, because `GetSessionToken` takes a
user's long-lived key and no role's: the job asks STS for a 900-second token with it before
anything else, and the harness hands that token to the `Expired` case once its expiration and a
minute have passed. Its policy grants `s3:GetObject`, `s3:PutObject`, `s3:DeleteObject`,
`s3:ListBucket`, `s3:ListBucketMultipartUploads` and `s3:AbortMultipartUpload` on the bucket.
On R2 both are API tokens scoped to the bucket, `Object Read & Write` and `Object Read only`.
R2 issues no token that could be let expire on purpose, so the `Expired` case reports itself
skipped there.

Both buckets carry the rule of `lifecycle.json`: objects expire after one day and a multipart
upload left behind is aborted after one day, which removes what a run that died before its
cleanup left. The CI credentials may not read bucket configuration, so the rule is set once
with an administrator's credential and not checked by the run:

```sh
aws s3api put-bucket-lifecycle-configuration --bucket <bucket> \
  --lifecycle-configuration file://harness/s3/lifecycle.json
aws s3api put-bucket-lifecycle-configuration --bucket <bucket> \
  --endpoint-url https://<account-id>.r2.cloudflarestorage.com \
  --lifecycle-configuration file://harness/s3/lifecycle.json
```

## Settled by the first run

`src/first-run.test.ts` asks the endpoint what spec 13 left open, beside the conformance cases
that answer the rest, and keeps asking it once the first run settled it. It runs only where
`STOWAGE_CONFORMANCE_INCLUDE_SLOW` is `true`. The last job of the workflow
writes a table of every point against every endpoint and runtime into the run's summary; a
promise the table shows disproved is withdrawn from `docs/spec.md` in a minor release.
