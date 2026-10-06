# The core sends a request with its attempts, and does not promise it

ADR 0013 put the loop of the retry policy into `@stowage/core` as `withRetry`, so that there is one
definition of the budget and the curve. Everything around the loop stayed in the adapters, and
`adapter-s3`, `adapter-azure-blob` and `adapter-gcs` each wrote it again:

- resolving the credential and re-telling its failure against the storage
- turning a transport failure into `NetworkError` while an `AbortError` travels on
- the one repeat under `forceRefresh` after a refused credential
- reading the failure body to the end
- counting the requests that went out

The copies drifted. `adapter-s3` turned an abort while reading a refusal into a `StorageError`,
against spec 4.10, while the other two let it travel on (#356). The two exceptions to the policy
went past `withRetry` as sentinels that are no `StorageError`, each with a hand-written count of the
attempts:

- `CompleteMultipartUpload`, which spec 7.5 does not repeat after a transport failure.
- `objects.move` on GCS, whose `404` after an attempt that may have moved the object reports that
  attempt's failure (ADR 0037).

The core now exports `sendRequest`, which sends one request with all its attempts. The adapter hands
it two callbacks. `prepare` is called once per attempt: it resolves and validates the credential,
under `forceRefresh` where asked, signs, and returns the URL, the headers and the body. The body is
held as bytes, so that the rule of ADR 0013 that a stream is never repeated holds by its type, and
the result says whether a refused credential of this attempt can be refreshed. `readFailure` gets
the status, the headers and the body of a refusal already read to the end, and returns the code,
the message, the key the failure is told against, the provider code, the request id, and whether
the provider refused the credential.

The core does everything else: the loop and the budget of ADR 0013, the repeat under `forceRefresh`,
the transport failure, the abort, reading the body, or not for `HEAD`, counting the attempts, and
building the `StorageError` from the provider, the bucket and the operation it is told. A request
names its rule for an attempt that received no response. `stop` is spec 7.5's rule. `reportOverNotFound`
is ADR 0037's, where a `5xx` counts as such an attempt too, since the move may have happened behind
it. Statuses besides `2xx` that answer a request, the `308` of a resumable session (ADR 0036), are
named per request as well. Reading the `retry` option, with its ceiling of three attempts, moves into
the core beside the loop it bounds.

The core never sees a signer, a key or a credential, only the request it signs, so ADR 0019 and ADR
0031 keep the signers in their adapters. ADR 0042 refused to publish a descriptor of the adapter's
internal `send`, because the exceptions, Azure's headers built per credential and GCS's paths would
make it a contract from its first release. `sendRequest` takes no descriptor of a request. It takes
two callbacks, the shape ADR 0030 chose for `uploadStream`, and the request is whatever `prepare`
builds.

`sendRequest` is exported and not promised. Spec 4.13 does not list it, its TSDoc says so, and ADR
0017 has a caller rely on the spec rather than on what TypeScript exports, so it may change in any
minor release. It shares what the adapters in this repository need, and an adapter written
elsewhere keeps `withRetry`, which stays promised. The other choice was promising it in spec 4.13
at once, as `uploadStream` was. That was declined for now: the shape has met three adapters and two
exceptions, and a third exception would have to wait for a minor that withdraws nothing. Promising
it later is an entry in spec 4.13 and moves no import.

The GCS resumable session sends each request through `sendRequest` with one attempt and `308` as an
answer, and keeps its own repeat around it. That repeat sends a chunk again from the first byte the
session has not acknowledged, which may take several requests, and is ADR 0036's rather than one
request's.

## Consequences

- An adapter in this repository keeps its signer, its paths, its failure formats with their
  provider codes, and its reading of what refuses a credential. The mechanics of an attempt are
  written once.
- `sendRequest` is tested in the core against a stubbed `fetch`. The adapters' tests drop what they
  repeated of it and keep what their callbacks decide.
- `adapter-azure-blob` and `adapter-gcs` read the body of a refused access token before the repeat
  rather than canceling it, as every other refusal is read. That costs the bytes of one error
  document and changes nothing a caller observes, except that a refusal whose body stalls holds
  the request until the caller's signal fires, which was already so for every other refusal.
- `withRetry` stays in spec 4.13 for adapters written outside this repository.
- A changeset marks `@stowage/core` minor. The adapters change nothing the spec promises.
