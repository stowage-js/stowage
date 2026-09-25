# The runtime matrix takes in the Azure adapter, and `workerd` runs the suite with and without `nodejs_compat`

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

`workerd` has enabled `nodejs_compat` by default since compatibility date 2026-08-04, which issue
107 measured: a Node-API bundle loads at 2026-09-01 without flags and fails with
`No such module "node:os"` once `no_nodejs_compat` is set. The v0.1 harness pins 2026-09-01 with
no flags, so its `workerd` cell no longer shows that an adapter reaches no Node API, for
`adapter-s3` as much as for Azure. The harness therefore runs the whole suite under
`no_nodejs_compat`, which proves the module graph, and runs the `fast` tier a second time under the
default flags, which is what a Worker at that date gets unless it opts out. The second run is there
because code that branches on `globalThis.process` or `Buffer` behaves differently under the two,
and the environment read ADR 0021 moves into `@stowage/core` is such code. The `slow` tier runs
once, under `no_nodejs_compat`: what the flag changes does not depend on the endpoint that answers.
The spec promises the `workerd` cells in both states, and CI covers both. Moving the date back
before 2026-08-04 would have pinned the runtime to a date that a Worker created today does not
run at, so the promise would describe a configuration few callers have. A static check of the
bundle for `node:` imports would have seen the imports and missed the globals, and proves less than
loading the bundle does.

The compatibility date stays `2026-09-01`. Nothing in v0.2 needs a later one, and the spec now
names the flags beside the date. A new date is a change to the spec; Renovate lifts the `workerd`
binary and leaves the date alone.

## Consequences

- Measured on 2026-09-25: the v0.1 worker bundle, `adapter-s3` included, loads under
  `no_nodejs_compat` at 2026-09-01, and every `adapter-memory` case passes. Adding the flag breaks
  nothing that exists today.
- `workerd.capnp` gains a second worker service with the same module and date and no flag, and the
  harness reports its results apart from those of the first. The comment claiming that the pinned
  date alone shows "no Node API" goes, and `worker.ts`'s remark that `fromEnv` finds no `process`
  holds for the `no_nodejs_compat` service alone.
- Node 24, Node 26 and `workerd` run the Azure adapter's `slow` tier against the real account, Bun
  and Deno against Azurite, the split ADR 0023 proposed after ADR 0012. The copy cases that diverge
  on Azurite stay admissible because the same cases run against the real account on Node and
  `workerd`. The spec carries the split as a note beside the matrix, as it does for S3.
- Flow 2 states its preconditions per adapter: for `s3` a bucket policy allowing
  `UNSIGNED-PAYLOAD` and a CORS configuration, for `azure-blob` a CORS rule allowing
  `x-ms-blob-type` and a storage built with `{ accessToken }` on the signing side. Azure is listed
  under the condition that the real account binds `Content-Type` and `Content-Length` through
  `srh`, which is checked before the v0.2 spec is written. If it does not, `azure-blob` leaves flow
  2's adapters and no cell changes, since `s3` carries them.
- No host limit takes an Azure cell away. Under an access token a block upload signs nothing and
  hashes nothing, ADR 0009 being S3's, and it holds 8 MiB × 4 as S3 does, so flow 1 costs less CPU
  on `workerd` than it does against S3. A presigned URL under an access token costs one subrequest
  for the user delegation key. The first scheduled run measures the 17 MiB upload of flow 1 on
  `workerd` against Azure as it did against S3; a result beyond a paid plan's limit changes the
  host note beside the matrix and no cell, since hosts are not promised.
- Flow 1 names all four runtimes. Its text has named Node, Bun and Deno since v0.1 while the
  matrix and ADR 0002 marked `workerd` as `yes`; the matrix was right.
- `flow/5-prefix-move` does not change. It never named a target provider.
