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
./harness/s3/stop.sh
```

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

Docker is required. Without `STOWAGE_S3_ENDPOINT` the run fails rather than passing with
the tier skipped (ADR 0012), and CI starts `compose.yml` itself before `pnpm test`.

The credential in `s3.json` is this container's and nothing else's: it authenticates a
local emulator holding a run's throwaway objects.

## What is not here yet

The divergence list of ADR 0012 — one entry per conformance case the endpoint answers
differently from the provider it stands in for — arrives once the cases it would describe
run. `conformance.test.ts` carries the cases `adapter-s3` cannot run yet instead, each
named by the operation that brings it.
