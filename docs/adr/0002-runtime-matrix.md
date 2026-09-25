# The runtimes v0.1 promises

v0.1 promises Node, Bun, Deno and `workerd`, cell by cell against the five reference flows
rather than as one list, because `adapter-fs` cannot exist on `workerd`.
Supported means one thing: the conformance suite covers that cell in CI. The alternative was a
second, weaker level for runtimes tried by hand before a release, and on a project with one
maintainer that is a promise which decays without anyone noticing.

Hosts are not listed. Cloudflare's network, Deno Deploy, AWS Lambda and Vercel inherit a
runtime and add limits this project cannot measure, so naming one would promise something the
conformance suite never checks. A host limit can still take a cell away; Cloudflare's does not
take flow 1, whose upload the first scheduled run measured within the CPU the paid Workers plans
allow, and the spec says so beside the matrix. The matrix promises less than the runtime can do,
never more.

|                                            | Node                 | Bun                  | Deno                 | `workerd`      |
| ------------------------------------------ | -------------------- | -------------------- | -------------------- | -------------- |
| 1 large upload from a server               | yes                  | yes                  | yes                  | yes            |
| 2 browser upload through a presigned `PUT` | yes                  | yes                  | yes                  | yes            |
| 3 file browser listing one prefix          | yes                  | yes                  | yes                  | yes            |
| 4 streaming download from an edge runtime  | yes                  | yes                  | yes                  | yes            |
| 5 move a prefix from the file system to S3 | yes                  | yes                  | yes                  | no             |
| adapters covered in CI                     | `memory`, `fs`, `s3` | `memory`, `fs`, `s3` | `memory`, `fs`, `s3` | `memory`, `s3` |

## Consequences

- Covered in CI means the whole conformance suite on that cell. ADR 0006 splits it into cases
  cheap enough for every commit and cases that run on a schedule and before a release, so a cell
  may be covered less often than every commit, but never by fewer cases.
- Node's floor is 24, and CI runs 24 and 26. Node 22 reaches end of life on 2027-04-30, inside
  the timeframe of this release, and adding a line back later costs less than taking one away.
- Bun and Deno have no floor: the README names the version CI last ran green. `workerd` is
  pinned to a compatibility date that the spec names.
- The `workerd` cell promises that no package needs a Node API, so that a Worker at an older
  date or one that opts out runs it too. A guarded read such as `fromEnv` looking for `process`
  keeps that promise. From 2026-08-04 the date alone turns on `nodejs_compat` and
  `nodejs_compat_v2`, and `no_nodejs_compat` alone still leaves `process`, `Buffer` and most
  `node:` modules reachable, so the harness runs with `no_nodejs_compat` and
  `no_nodejs_compat_v2` beside the date. A second worker at the date's defaults shows that the
  probe of the harness would see a Node API, and that `fromEnv` reads the bindings there.
- `adapter-fs` declares Node, Bun and Deno, while `@stowage/core`, `adapter-memory` and
  `adapter-s3` declare all four. Each package declares its own runtimes in the spec and the
  README, and through `engines` for the Node floor alone, which Bun and Deno ignore.
- Nothing detects the runtime at import time. Four runtimes are promised; the rest is neither
  blocked nor supported.
- Dropping a runtime, or a Node line that reaches end of life, is not a breaking change. It leads
  the changelog entry, and ADR 0017 keeps it outside the contract after 1.0 as well.
- An adapter never hands `fetch` a body stream of unknown length. Below undici 8.6.0 such a
  body is retained whole and grows without a ceiling — 512 MB measured for a 512 MB body on
  Node 24.21.0 — and every Node 24 release bundles undici 7. Multipart upload makes the part
  size the memory limit on every line, so no line needs a second code path and Node 26.5.0 gets
  no cell of its own.
