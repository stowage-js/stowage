# The runtimes v0.1 promises

v0.1 promises Node, Bun, Deno and Cloudflare Workers, cell by cell against the five reference
flows rather than as one list, because `adapter-fs` cannot exist on Workers and a large upload
from a Worker runs against a CPU and duration budget this project has not measured. Supported
means one thing: the conformance suite covers that cell in CI. The alternative was a second,
weaker level for runtimes tried by hand before a release, and on a project with one maintainer
that is a promise which decays without anyone noticing.

Hosts are not listed. Deno Deploy, AWS Lambda and Vercel inherit a runtime and add limits this
project cannot measure, so naming one would promise something the conformance suite never
checks.

|                                            | Node                 | Bun                  | Deno                 | Workers        |
| ------------------------------------------ | -------------------- | -------------------- | -------------------- | -------------- |
| 1 large upload from a server                | yes                  | yes                  | yes                  | no             |
| 2 browser upload through a presigned `PUT`  | yes                  | yes                  | yes                  | yes            |
| 3 file browser listing one prefix           | yes                  | yes                  | yes                  | yes            |
| 4 streaming download from an edge runtime   | yes                  | yes                  | yes                  | yes            |
| 5 move a prefix from the file system to S3  | yes                  | yes                  | yes                  | no             |
| adapters covered in CI                      | `memory`, `fs`, `s3` | `memory`, `fs`, `s3` | `memory`, `fs`, `s3` | `memory`, `s3` |

## Consequences

- Node's floor is 24, and CI runs 24 and 26. Node 22 reaches end of life on 2027-04-30, inside
  the timeframe of this release, and adding a line back later costs less than taking one away.
- Bun and Deno have no floor: the README names the version CI last ran green. Workers is pinned
  to a compatibility date that the spec names.
- `adapter-fs` declares Node, Bun and Deno, while `@stowage/core`, `adapter-memory` and
  `adapter-s3` declare all four. Each package declares its own runtimes in the spec and the
  README, and through `engines` for the Node floor alone, which Bun and Deno ignore.
- Nothing detects the runtime at import time. Four runtimes are promised; the rest is neither
  blocked nor supported.
- Dropping a runtime, or a Node line that reaches end of life, is not a breaking change in 0.x.
  It leads the changelog entry.
- An adapter never hands `fetch` a body stream of unknown length. Below undici 8.6.0 such a
  body is retained whole and grows without a ceiling — 512 MB measured for a 512 MB body on
  Node 24.21.0 — and every Node 24 release bundles undici 7. Multipart upload makes the part
  size the memory limit on every line, so no line needs a second code path and Node 26.5.0 gets
  no cell of its own.
