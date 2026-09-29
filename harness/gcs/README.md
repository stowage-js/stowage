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
`harness/s3/start.sh` and `harness/azure-blob/start.sh` belong beside it. Docker and `curl` are
required. Without `STOWAGE_GCS_ENDPOINT` and `STOWAGE_GCS_BUCKET` the run fails rather than passing
with the tier skipped (ADR 0012), and CI starts `compose.yml` itself before the harnesses run. A
machine without Docker sets `STOWAGE_CONFORMANCE_ENDPOINTS` to `none`, as `harness/s3/README.md`
describes.

fake-gcs-server listens on `127.0.0.1:4443`. Where that port is taken, `STOWAGE_GCS_PORT` names
another one, and both the printed endpoint and the emulator's `-public-host` follow it.

`start.sh` recreates the container, which starts empty, creates the bucket the suite writes to and
prints the environment the run reads:

| Variable               | What it names                                     |
| ---------------------- | ------------------------------------------------- |
| `STOWAGE_GCS_ENDPOINT` | The URL the adapter is constructed against        |
| `STOWAGE_GCS_BUCKET`   | The bucket the run writes below its own prefix in |

## The credential

Every case runs under the fixed token `fake-gcs-server`, which the adapter sends as the bearer of
every request and the emulator never reads. The target supplies neither
`createStorageWithBadCredentials` nor `createStorageWithDeniedCredentials`, so both cases report
themselves skipped, and the `Expired` case is skipped against every GCS endpoint (ADR 0033).

## The cases run so far

The adapter gains its operations one ticket at a time, and `src/target.ts` names the cases it
passes. A case joins that list with the operation it needs, until the list is the whole suite.
Only the Node harness runs the tier so far; Bun, Deno and `workerd` join it through the harnesses
they share with the other endpoints.
