# stowage is written to be found

ADR 0018 measured success as the author using stowage and a handful of others finding it, and drew
its documentation from that measure: no site, no `examples/` workspace, no `CODE_OF_CONDUCT.md`, no
issue templates, and a root README whose job is getting a reader into the spec. v0.6 publishes
eleven packages, keeps its promises against four cloud providers that a scheduled run answers, and
fits into three frameworks. The measure is now that stowage is found and used by the developers it
was built for: first a TypeScript developer who calls a provider's SDK directly and wants to develop
against local disk, then a developer on `workerd`, Deno or Bun, for whom those SDKs are too heavy or
do not run. This replaces the measure ADR 0018 started from, and each consequence that rested on it
was weighed again on its own.

A trial on 2026-10-10 installed 0.6.0 from npm into the project `npm init -y` writes and ran the
first block of the root README unchanged. The README named no package to install. The project npm
writes is CommonJS, and the block, a module, failed with `Cannot use import statement outside a
module`. As a module it failed again, with `NotFound`, because `/var/lib/my-app/storage` did not
exist, and spec 6 asks for an existing directory. A reader who copies the first block meets two
failures before seeing it work, and nothing in this repository noticed: the code-block test
compiles each block against the workspace's declarations and runs none of them.

A table comparing stowage with other storage libraries was weighed and ruled out. What it says
about another project goes stale without a check, which is the second text ADR 0018 wrote its rule
against, and the reader who comes from a provider's SDK is not choosing among libraries. Saying when
not to use stowage serves that reader as well. It states what spec 17 already holds, and names
one library only where a reader who needs a key-value store rather than objects should look
instead, a claim about what that library is for rather than about how it compares.

The rest of ADR 0018 stands on reasons of its own. A documentation site is still a second text to
hold against the spec, and spec 17 keeps it out. A test that installs the packages and runs a block
is not an example a reader opens, so `examples/` stays out as well. One maintainer is still not an
enforcement body, so there is no `CODE_OF_CONDUCT.md`. The npm name collision is still answered by
`description` and `keywords`.

## Consequences

- The root README opens with the sentence of `CONTEXT.md`, three badges (the version on npm, CI,
  the license), and one sentence on the state of the project: below 1.0 a minor release may withdraw
  a promise, and 1.0 waits for what spec 15 names. The install line follows as a `sh` block, the
  one block besides the `ts` blocks of ADR 0018 and ADR 0055, with a sentence that the blocks are
  modules and that `root` names a directory that exists. ADR 0055 added no code block to the root
  README; this `sh` block is the one exception.
- A section "Why stowage" follows the two opening blocks. Each point stands beside the place that
  holds it: no SDK beneath an adapter, the four runtimes of spec 2, the measured bundle sizes, the
  conformance suite against emulators on every pull request and against the cloud providers on a
  schedule, the ten error codes, and the spec as what a caller may rely on. A size is written as
  measured, since
  ADR 0003 records it and promises nothing.
- A section "When not to use stowage" names what spec 17 keeps out, the provider features and
  bucket management among them, and that a compatible endpoint can be configured and is not
  promised. It names unstorage for a key-value store and makes no other claim about another
  library.
- Every package README opens with one sentence leading to the root README, before its sections,
  because npm shows a package its own README and a reader who lands on one package never sees the
  root's.
- `CONTRIBUTING.md` states how to build, test and start the emulators, the changeset and the
  Conventional Commits a pull request carries, and how an adapter outside this repository runs
  `@stowage/conformance`.
- One issue form for a bug asks for the package, its version, the provider, picked from the
  promised providers or named as a compatible endpoint, and the runtime. Blank issues stay open,
  and the security policy is linked beside them.
- A CI job installs the packed packages with npm into an empty project outside the workspace and
  runs the first block of the root README against a temporary `root`, read from the README rather
  than copied, so the two cannot drift apart. It runs on Node, and joins the required checks once
  it has run green for a while.
- The keywords of `@stowage/core` and the five adapters gain `cloud-storage` and `file-storage`, those
  of `@stowage/http` and the three integrations `upload` and `download`. The repository's
  description and topics are set in GitHub's settings and name the promised providers, the
  integrations and the runtimes. `minio` stays a topic: a topic is a way in, not a promise, and the
  README's note on compatible endpoints sets the expectation.
- Spec 16 changes with this decision. It describes documentation and promises a caller nothing, so
  the change is editorial under ADR 0017 and carries no changeset.
- `CONTEXT.md` gains no term.
