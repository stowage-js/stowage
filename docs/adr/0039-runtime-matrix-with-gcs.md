# The runtime matrix takes in the GCS adapter

ADR 0031 has `@stowage/adapter-gcs` speak the JSON API on `fetch` and Web Crypto with no runtime
dependency, and ADR 0033 reads nothing from the host, so GCS takes no cell of ADR 0002's matrix
away. The matrix keeps its shape and gains `gcs` in the row of adapters covered in CI on all four
runtimes; the package declares Node, Bun, Deno and `workerd`. `gcs` joins flows 1, 2, 3 and 4, and
flow 5 moves from `fs` to `s3`, `azure-blob` or `gcs`.

The Bun and Deno cells stay `yes` while they run against fake-gcs-server alone, the split ADR 0034
took from ADR 0026. Against that emulator fewer cases observe a refusal than against Azurite: it
checks no credential and no signature, so the Bad and Denied cases are skipped, and
`presign/expired-url`, `presign/put-rejects-length` and `presign/put-rejects-type` fail by
construction; it serves no `moveTo`, so `move/round-trip` and `move/missing-source` fail as well
(ADR 0037). ADR 0002 counts a cell by the suite that covers it, never by fewer cases, and ADR 0012
admits a divergence where the same case runs against a real endpoint. Each of these cases does, on
Node 24, Node 26 and `workerd`, and none of them depends on the runtime: the credential cases test
the adapter's repeat after `401` with `forceRefresh`, which is the same code on every runtime; a
refused signed URL is the server's behavior, while the URL the adapter builds is served by the
emulator on every runtime and its signature is checked there by Google's 40 RSA V4 vectors; `move`
is one request. The cell means what it means for S3 and Azure: the whole suite, answered by the
emulator on Bun and Deno. The spec's note beside the matrix names what that emulator does not
check.

Running Bun and Deno against the real bucket as well was the alternative. It costs two jobs and
cents a month, and it would be the one provider whose Bun and Deno columns meet the real service,
without a failure it could catch that the cases on Node and `workerd` do not. A weaker word for the
two cells, such as "emulator", is the second support level ADR 0002 rules out.

## Consequences

- Flow 1 names what a failed upload leaves on GCS: nothing the API shows, and a session whose
  `DELETE` did not arrive keeps its bytes for up to a week (ADR 0036). Its "Fails as" states that on
  GCS a credential expiring during the upload does not fail it, since the chunks carry no token; a
  token refused when the session starts ends, after the one repeat with `forceRefresh`, in
  `InvalidCredentials` and never in `Expired` (ADR 0033).
- Flow 2 requires, on `gcs`, a storage built with a `signer` and a CORS rule on the bucket allowing
  the origin, `PUT` and `content-type` (ADR 0035). GCS answers a rejected upload with the rule's CORS
  headers, so a page reads the status; an expired URL answers `400`, not `403`. That signing through
  `signBlob` costs one request per URL, a subrequest on `workerd` as Azure's user delegation key is,
  belongs to the adapter's section and not to the flow.
- Flow 4 adds to "Fails as" that a range on an object stored gzip-compressed is `ProviderError`
  (ADR 0032). The two requests `get` sends side by side stay in the adapter's section: they hold
  back the first byte by the slower of the two, not their sum, change nothing the flow says holds,
  and a host's limit on subrequests is not promised.
- Flow 3 changes nothing, since it names all adapters. `flow/5-prefix-move` does not change.
- The note beside the matrix gains fake-gcs-server per commit and `gcs` in the `slow` tier's split:
  the real bucket on Node and `workerd`, fake-gcs-server on Bun and Deno, which checks no
  credential and no signature and serves no `moveTo`, so those cases run against the real bucket
  alone.
- Flow 1 on `workerd` is promised for the runtime and on no host, as for S3 and Azure. The first
  scheduled run against the bucket measures the 17 MiB upload's time and CPU for the whole
  `workerd` process, the token exchanges of ADR 0034 included. The chunks go one after another
  rather than four side by side, so it will likely take longer than against S3 and Azure; nothing is
  signed or hashed per chunk, so the CPU should not be higher. A result beyond a paid plan's limit
  changes the host note and no cell, so the point joins spec section 13 as recorded only.
- The compatibility date stays `2026-09-01`. What `adapter-gcs` asks of `workerd` beyond the other
  adapters is importing a PKCS#8 RSA key and signing with RSASSA-PKCS1-v1_5, which reproduced all 40
  V4 vectors on `workerd` 1.20260927.1 (`docs/research/gcs-auth.md` on `research/gcs-auth`). A later
  date becomes a change to the spec only if the vector test fails at the pinned one.
- The macOS job runs no GCS (ADR 0034), and the matrix has no macOS column for a cloud adapter.
