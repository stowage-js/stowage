# The runtime matrix takes in the Azure adapter

ADR 0019 has `@stowage/adapter-azure-blob` speak the wire protocol on `fetch` and Web Crypto with
nothing that needs a Node API, so Azure takes no cell of ADR 0002's matrix away. The matrix keeps
its shape, reference flows against runtimes, and gains `azure-blob` in the row of adapters covered
in CI on all four runtimes; the package declares Node, Bun, Deno and `workerd`. Which adapters a
flow covers stays in the flow's text: `azure-blob` joins flows 1, 2, 3 and 4, and flow 5 becomes
"move a prefix from the file system to a cloud provider", from `fs` to `s3` or `azure-blob`, since
its conformance case never named a provider. A matrix per adapter, or adapters against runtimes
within each flow, was the alternative. It would have repeated the same cells, because a cell says
that the suite covers a flow on a runtime, and which adapters carry the flow is already the flow's
to say.

On `workerd` the Azure adapter runs in the harness worker of ADR 0002, at compatibility date
`2026-09-01` with `no_nodejs_compat` and `no_nodejs_compat_v2`, where no Node API is reachable, so
its cell shows that it needs none, as `adapter-s3`'s does.

The compatibility date stays `2026-09-01`. Nothing in v0.2 needs a later one, and moving it back
before 2026-08-04, where the Node APIs are off without flags, would pin the runtime to a date that a
Worker created today does not run at. A new date is a change to the spec; Renovate lifts the
`workerd` binary and leaves the date alone.

## Consequences

- Node 24, Node 26 and `workerd` run the Azure adapter's `slow` tier against the real account, Bun
  and Deno against Azurite, the split ADR 0023 proposed after ADR 0012. The copy cases that diverge
  on Azurite stay admissible because the same cases run against the real account on Node and
  `workerd`. The spec carries the split as a note beside the matrix, as it does for S3.
- Flow 2 states its preconditions per adapter: for `s3` a bucket policy allowing
  `UNSIGNED-PAYLOAD` and a CORS configuration, for `azure-blob` a CORS rule allowing
  `x-ms-blob-type` and a storage built with `{ accessToken }` on the signing side. Azure is listed
  under the condition that the real account binds `Content-Type` and `Content-Length` through
  `srh`, which is checked before the v0.2 spec is written. If it does not, `azure-blob` leaves flow
  2's adapters and no cell changes, since `s3` carries them. The account showed on 2026-09-25 that
  both headers are bound (`docs/research/azure-srh-binding.md`), so `azure-blob` stays listed.
- No host limit takes an Azure cell away. Under an access token a block upload signs nothing and
  hashes nothing, ADR 0009 being S3's, and it holds 8 MiB × 4 as S3 does, so flow 1 costs less CPU
  on `workerd` than it does against S3. A presigned URL under an access token costs one subrequest
  for the user delegation key. The first scheduled run measures the 17 MiB upload of flow 1 on
  `workerd` against Azure as it did against S3; a result beyond a paid plan's limit changes the
  host note beside the matrix and no cell, since hosts are not promised.
- Flow 1 names all four runtimes. Its text has named Node, Bun and Deno since v0.1 while the
  matrix and ADR 0002 marked `workerd` as `yes`; the matrix was right.
- `flow/5-prefix-move` does not change. It never named a target provider.
- The `workerd` harness runs the whole suite under `no_nodejs_compat` and `no_nodejs_compat_v2`,
  which shows that no Node API is reached, and the `fast` tier a second time under the date's
  default flags, because code that branches on `process` or `Buffer` behaves differently under
  each, as the environment read of ADR 0021 does. The `slow` tier runs once, without the Node APIs.
  The spec promises the cells in both flag states.
