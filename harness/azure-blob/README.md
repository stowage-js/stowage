# The Azure Blob endpoint the conformance suite runs against

ADR 0023 picked Azurite: it verifies Shared Key and SAS signatures, takes a bearer token under
`--oauth basic`, answers with the service's error codes and checks `x-ms-version`.
`compose.yml` pins the image by digest, and that digest is what CI starts and what green means.
It runs the blob service alone, in memory, in strict mode and with the version check live.

## Running the suite against it

```sh
eval "$(./harness/azure-blob/start.sh)"
pnpm test
./harness/azure-blob/stop.sh
```

`pnpm test` runs the Node column of spec 2, the S3 tier included, so `harness/s3/start.sh` belongs
beside it. Docker and `openssl` are required. Without `STOWAGE_AZURE_BLOB_ENDPOINT` the run fails
rather than passing with the tier skipped (ADR 0012), and CI starts `compose.yml` itself before the
harnesses run.

Azurite listens on `127.0.0.1:10000`. Where that port is taken, `STOWAGE_AZURE_BLOB_PORT` names
another one, and the printed endpoint follows it.

`start.sh` generates a self-signed certificate for `127.0.0.1` on every start, because Azurite
takes a bearer token over HTTPS alone, and makes it no CA, since Deno refuses a CA certificate a
server presents as its own. It recreates the container with it, creates the container the suite
writes to and prints the environment the run reads:

| Variable                           | What it names                                                  |
| ---------------------------------- | -------------------------------------------------------------- |
| `STOWAGE_AZURE_BLOB_ENDPOINT_NAME` | Which server answers, `azurite`, read by the divergence list   |
| `STOWAGE_AZURE_BLOB_ENDPOINT`      | The URL the adapter is constructed against, the account's path |
| `STOWAGE_AZURE_BLOB_ACCOUNT`       | The account, Azurite's `devstoreaccount1`                      |
| `STOWAGE_AZURE_BLOB_CONTAINER`     | The container the run writes below its own prefix in           |
| `AZURE_STORAGE_KEY`                | Read by `fromEnv`: Azurite's published key for that account    |
| `NODE_EXTRA_CA_CERTS`              | The certificate, which Node trusts beside its own CAs          |

The key is the one Microsoft publishes for the emulator and authenticates nothing else.

## Two credentials

Every conformance case runs under an access token (ADR 0023). Azurite checks a token's times,
issuer and audience and no signature, so `src/token.ts` mints an unsigned JWT for the audience
`https://storage.azure.com`, fresh for every request the resolver is asked for. It names a
principal in `oid` and its tenant in `tid`, without which Azurite answers the user delegation key
the presign cases request with an empty `500`. The account key reaches the endpoint through
`src/adapter-azure-blob.test.ts`, which holds Shared Key against the same container.

## The cases run so far

The adapter gains its operations one ticket at a time, and `src/target.ts` names the cases it
passes. A case joins that list with the operation it needs, until the list is the whole suite.

## The divergence list

`src/divergences.ts` holds one entry per conformance case Azurite answers differently from the
account (ADR 0012, ADR 0023), read against `STOWAGE_AZURE_BLOB_ENDPOINT_NAME`, which `start.sh`
sets to `azurite`. The mechanism is the S3 harness's: against the endpoint an entry names, the
case passes where it fails as the entry says and fails where it passes. The six cases that send
a copy are on it while the pinned Azurite lacks `Put Blob From URL` and ignores
`x-ms-copy-source-authorization` (ADR 0025). `presign/put` and `flow/2-presigned-put` are on it
because Azurite leaves the headers `srh` names out of the string to sign of a user delegation SAS,
and so refuses the upload the real account accepts (ADR 0022).
