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
pnpm test:bun
pnpm test:deno
./harness/s3/stop.sh
```

`pnpm test` runs the Node column of spec 2 and the `workerd` one, whose driver runs on
Node and starts the `workerd` that `harness/workerd` pins. The other two runtimes are not
dependencies: `pnpm test:bun` and `pnpm test:deno` need Bun and Deno installed, in the
versions `.bun-version` and `.dvmrc` pin for CI.

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

The credential the provider accepts and refuses a write to, which spec 8.3 asks a target
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

## What is not here yet

The divergence list of ADR 0012 — one entry per conformance case the endpoint answers
differently from the provider it stands in for — arrives once the cases it would describe
run.
