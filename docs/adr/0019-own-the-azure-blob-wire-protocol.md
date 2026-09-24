# The Azure Blob adapter implements the wire protocol itself

`@stowage/adapter-azure-blob` signs its own requests and speaks the Blob REST API directly, and it
ships no runtime dependency. ADR 0003 made that the rule for every adapter after S3 and left one
exception, a library where authentication is out of reach of web standards. Azure does not reach
it. Shared Key and all three kinds of SAS are HMAC-SHA256 over a UTF-8 string with a
base64-decoded key, and every Entra ID flow ends in a bearer token that one `fetch` obtains: a form
`POST` to the token endpoint, carrying a secret or a PS256 client assertion that Web Crypto signs,
or a managed-identity `GET`. Two pieces sit outside web standards: the projected token file of workload identity on
Kubernetes and PKCS#12 certificate files. Both concern how a credential arrives rather than how a
request is signed, so under ADR 0007 they belong to a resolver the caller writes, not to the
adapter.

The objection ADR 0003 raised against `@aws-sdk/client-s3` was its form, and `@azure/storage-blob`
12.33.0 has the same one, measured across the four runtimes. The service's error code is
`RestError.code` when a response has a body and `details.errorCode` when it has none, as on every
`HEAD`. The retry policy cannot be replaced, and it disagrees with ADR 0013 on the count, on
jitter, on which statuses it repeats and on streams: it sends a Node `Readable` again after the
first attempt consumed it, and the caller meets a `400` or a hang. Uploads accept a Node `Readable`
and refuse a web `ReadableStream` on every runtime. On `workerd` the SDK runs only as its Node
build under `nodejs_compat`, and the build that the worker conditions resolve throws at import. As
in ADR 0003, size is not the deciding cost, although a put, get, list and delete client comes to
148 KiB gzipped against 13.4 kB for `adapter-s3`.

The partial answer was an own wire protocol with `@azure/identity` as an optional peer for Entra
ID. It keeps none of what it promises. ADR 0003 declares no peer dependency on the S3 path, and an
optional one is still a second version range to test against. `@azure/identity` needs Node APIs on
every runtime, since its `workerd` build is a byte-identical copy of the Node one. And a credential
bridge is outside v0.2 altogether. Wherever the adapter accepts a bearer token, a caller who
already holds an `@azure/identity` credential wraps it in a resolver of their own.

Owning the protocol costs code that nobody has estimated yet. `adapter-s3` is 3,959 lines without
its tests, and the Shared Key spike gives the Azure adapter its own number before the spec is
written.

## Consequences

- No published package has a runtime dependency, and ADR 0008's promise holds for six packages.
  `@stowage/adapter-azure-blob` joins the `fixed` version group of ADR 0008.
- `@azure/storage-blob` is a pinned development dependency and the oracle the Shared Key and SAS
  signer is compared against, beside Azurite as the verifier. Microsoft publishes no test vectors
  for either, so there is nothing else to compare against. `@azure/identity` is not a dependency in
  any form.
- What two adapters need on the wire is defined once, in `@stowage/core`, among the exports for
  adapter authors, where ADR 0013 already put the retry loop and the status table. The XML parser
  of ADR 0003 moves there first, because List Blobs and Put Block List are XML, and `adapter-s3`
  imports it from the core. It keeps rejecting CDATA and DTDs. The spec states it like every other
  export, so ADR 0017 governs a change to it. A piece that one adapter alone needs stays in that
  adapter.
- The signers stay in their adapters. SigV4 and Shared Key have nothing in common beyond
  HMAC-SHA256, which Web Crypto already provides.
- The adapter uses `withRetry` and the transient conditions of ADR 0013. Azure throttles with
  `503 ServerBusy` and `500 OperationTimedOut`, both already in the retry group, so none of its
  own retry code needs to be switched off.
- Nothing the adapter does needs a Node API, so the decision itself takes no cell of the runtime
  matrix of ADR 0002 away. Which cells the adapter promises is decided separately, together with a
  `workerd` harness that can show again that an adapter reaches no Node API.
- `@stowage/adapter-azure-blob-sdk`, built on the official SDK, is the way back, with the two
  triggers ADR 0003 names for `@stowage/adapter-s3-sdk`: a promised provider needs behavior that
  cannot be written here in reasonable time, or wire-level defects reach users repeatedly instead
  of the conformance suite. It would carry its own ADR, join the same version group and pass the
  same conformance suite. Until Microsoft ships a build without Node APIs, its `workerd` cell would
  need `nodejs_compat` and a bundle that resolves the `node` condition.
