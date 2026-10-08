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
beside it. `pnpm test:bun`, `pnpm test:deno` and `pnpm test:workerd` run the same tier in the other
three columns, against the same endpoint. Docker and `openssl` are required. Without
`STOWAGE_AZURE_BLOB_ACCOUNT` and `STOWAGE_AZURE_BLOB_CONTAINER` the run fails rather than passing
with the tier skipped (ADR 0012), and CI starts `compose.yml` itself before the harnesses run.
A machine without Docker sets `STOWAGE_CONFORMANCE_ENDPOINTS` to `none`, as `harness/s3/README.md`
describes.

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
| `NODE_EXTRA_CA_CERTS`              | The certificate, which Node and Bun trust beside their own CAs |
| `DENO_CERT`                        | The same certificate, which Deno trusts beside its own CAs     |

The key is the one Microsoft publishes for the emulator and authenticates nothing else. `workerd`
reads no variable for a certificate: the `workerd` harness copies the file to where
`workerd.capnp` names it in `tlsOptions.trustedCertificates` (ADR 0023), and a placeholder whose
key nobody holds where `start.sh` has not run, so that `workerd` starts and the missing endpoint
fails its check.

## The `workerd` harness

The worker runs the tier under `no_nodejs_compat` and `no_nodejs_compat_v2`, where no Node API is
reachable, and runs its `fast` cases a second time under the default flags of the compatibility
date (ADR 0026). Both runs take the whole suite and the divergence list from `src/`, so a case
that joins the suite runs in every column.

## Two credentials

Every conformance case runs under an access token (ADR 0023). Azurite checks a token's times,
issuer and audience and no signature, so `src/token.ts` mints an unsigned JWT for the audience
`https://storage.azure.com`, fresh for every request the resolver is asked for. It names a
principal in `oid` and its tenant in `tid`, without which Azurite answers the user delegation key
the presign cases request with an empty `500`. Against the account the token is the one Entra
exchanges the job's OIDC token for (see below), and that is what `STOWAGE_AZURE_BLOB_CLIENT_ID`
decides: set, the harness never mints a token. The account key reaches the endpoint through
`src/adapter-azure-blob.test.ts`, which holds Shared Key against the same container across the
operations of the parity core (spec 14.4): user metadata named `a1` and `a_` with a value holding
a run of spaces, a stream staged as blocks, `presignGet` as a service SAS and `presignPut` refused
before any request. The copy and the move report themselves skipped where the endpoint answers
`Put Blob From URL` with `501`, as the pinned Azurite does (ADR 0025). It runs against Azurite on
every commit, asks nothing of the endpoint the account does not answer, so that a future `slow` tier
can run it against the account as it is, and delete what it wrote once it is done.

## The real account

`.github/workflows/conformance-full.yml` runs both tiers on a schedule, on demand and for a
release workflow to call: on Node 24, Node 26 and `workerd` against the account, and on Bun and
Deno against Azurite (ADR 0026). Its jobs set `STOWAGE_CONFORMANCE_ENDPOINTS` to the one tier
their environment holds, `azure-blob` here and `s3` in the jobs against S3, so that the other
tier's endpoint check stays out of their run. Unset, a run asks for both.

The account is `stowageconformance` in `swedencentral`, and the run writes to its one container,
`stowage-conformance`. The GitHub environment `azure-blob`, restricted to `main`, holds:

| Name                                  | Kind     | What it holds                                                                    |
| ------------------------------------- | -------- | -------------------------------------------------------------------------------- |
| `STOWAGE_AZURE_BLOB_ACCOUNT`          | variable | The account, `stowageconformance`                                                |
| `STOWAGE_AZURE_BLOB_CONTAINER`        | variable | The container, `stowage-conformance`, which holds nothing else                   |
| `STOWAGE_AZURE_BLOB_TENANT_ID`        | variable | The tenant of both managed identities                                            |
| `STOWAGE_AZURE_BLOB_CLIENT_ID`        | variable | The client id of `stowage-ci`, Storage Blob Data Contributor on the account      |
| `STOWAGE_AZURE_BLOB_DENIED_CLIENT_ID` | variable | The client id of `stowage-ci-readonly`, Storage Blob Data Reader alone           |
| `STOWAGE_AZURE_BLOB_ACCOUNT_KEY`      | secret   | key1 of the account, which the Node jobs hand the harness as `AZURE_STORAGE_KEY` |

The job sets `STOWAGE_AZURE_BLOB_ENDPOINT_NAME` to `azure-blob` and no
`STOWAGE_AZURE_BLOB_ENDPOINT`, so the adapter addresses `https://stowageconformance.blob.core.windows.net`
as a caller in the public cloud does.

No secret holds a token. The job holds `id-token: write`, and `src/federated-token.ts` asks the
Actions runtime for an OIDC token with the audience `api://AzureADTokenExchange`, exchanges it at
`https://login.microsoftonline.com/<tenant>/oauth2/v2.0/token` as a `client_assertion` for the
scope `https://storage.azure.com/.default`, keeps the result until five minutes before it
expires and fetches a new one on `forceRefresh`. Each identity carries a federated credential for
the issuer `https://token.actions.githubusercontent.com`, the subject
`repo:stowage-js@325610168/stowage@1359085380:environment:azure-blob` and that audience. The token
names the owner and the repository by name and id; a credential for
`repo:stowage-js/stowage:environment:azure-blob` meets `AADSTS700213`. On `workerd` the bindings of
`workerd.capnp` carry the tenant, both client ids, `ACTIONS_ID_TOKEN_REQUEST_URL` and
`ACTIONS_ID_TOKEN_REQUEST_TOKEN`, and the worker does the same exchange.

`createStorageWithDeniedCredentials` runs under `stowage-ci-readonly`, which the account answers
with `AuthorizationPermissionMismatch` on a write, and `errors/denied-credentials` reads that as
`AccessDenied`. Against Azurite, which checks no role, the case reports itself skipped.
`createStorageWithBadCredentials` hands over a token that is not a JWT on both endpoints.
`createStorageWithMissingBucket` binds the configured account to a container named at random, and
both endpoints name it `ContainerNotFound`, on a `HEAD` and in every subresponse of a Blob Batch,
which is `NotFound` without `key` (ADR 0043).

The account carries two rules the CI identities may not change, set once by the account's owner.
A lifecycle rule deletes a block blob one day after its last modification, which removes what a
run that died before its cleanup left; the service discards uncommitted blocks after seven days
on its own. The one CORS rule is what flow 2 needs from a page and what the probe of the expired
presigned URL preflights against: the origin `https://conformance.stowage.invalid`, the methods
`GET` and `PUT`, and the headers `content-type`, `x-ms-blob-type` and `x-ms-blob-content-type`,
which the probe sends because `presignPut` returns them. The rule allows none of the other content
headers, since the probe signs none (ADR 0064). `cors add` appends a rule, so the commands clear
the old one first.

```sh
az storage account management-policy create --account-name stowageconformance \
  --resource-group stowage-conformance --policy '{"rules": [{"enabled": true,
  "name": "delete-after-one-day", "type": "Lifecycle", "definition": {"filters":
  {"blobTypes": ["blockBlob"]}, "actions": {"baseBlob": {"delete":
  {"daysAfterModificationGreaterThan": 1}}}}}]}'
az storage cors clear --account-name stowageconformance --services b --auth-mode key
az storage cors add --account-name stowageconformance --services b --auth-mode key \
  --origins https://conformance.stowage.invalid --methods GET PUT \
  --allowed-headers content-type x-ms-blob-type x-ms-blob-content-type --max-age 0
```

## Settled by the first run

`src/first-run.test.ts` asks the account what spec 18 left open for Azure, beside the conformance
cases that answer the rest, together with the tests of spec 14.4 only the account can answer: the
three response overrides of `presignGet`, a `Put Block List` sent twice, a `Put Blob` discarding
the uncommitted blocks of its name, and the CORS headers on the `403` for an expired presigned URL
after a preflight from the rule's origin. It runs only where `STOWAGE_CONFORMANCE_INCLUDE_SLOW` is
`true` and `STOWAGE_AZURE_BLOB_ENDPOINT_NAME` is `azure-blob`. The upload of 5,000 MiB that
records the refusal of a copy above the service's limit runs on Node 24 alone. The `workerd`
harness runs `flow/1-large-upload` once more on its own there and reports its duration and the
CPU the `workerd` process spent.

The last job of the workflow writes the points into the same table as the S3 ones, in the columns
`azure-blob-node-24`, `azure-blob-node-26` and `azure-blob-workerd`.

## The divergence list

`src/divergences.ts` holds one entry per conformance case Azurite answers differently from the
account (ADR 0012, ADR 0023), read against `STOWAGE_AZURE_BLOB_ENDPOINT_NAME`, which `start.sh`
sets to `azurite`. The mechanism is the S3 harness's: against the endpoint an entry names, the
case passes where it fails as the entry says and fails where it passes. The six cases that send
a copy are on it while the pinned Azurite lacks `Put Blob From URL` and ignores
`x-ms-copy-source-authorization` (ADR 0025). `presign/put` and `flow/2-presigned-put` are on it
because Azurite leaves the headers `srh` names out of the string to sign of a user delegation SAS,
and so refuses the upload the real account accepts (ADR 0022). `list/noncharacter-key` stays
unrun against Azurite, which answers a listing of a name holding `U+FFFE` with `500`: the blob
the case leaves behind would fail the run's `cleanup` the same way (#171).
