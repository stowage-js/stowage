# Five packages, published ESM only and versioned in lockstep

v0.1 publishes one npm package each for `@stowage/core`, `@stowage/adapter-memory`,
`@stowage/adapter-fs`, `@stowage/adapter-s3` and `@stowage/conformance`. ADR 0002 already forced
the split for `adapter-fs`, which declares Node, Bun and Deno while the others declare `workerd`
as well: a package that promises `workerd` cannot carry `node:fs` in its module graph.
`adapter-memory` is separate for a different reason. It is the implementation a third-party
adapter is read against, and a subpath of `@stowage/core` cannot show what an adapter looks like
from outside the core. The alternative was a single package, which makes the zero-dependency
promise trivial to keep and puts the file system adapter into every Worker bundle.

Everything is published ESM only. The Node floor is 24, where `require()` of a fully synchronous
ESM graph works unflagged, so a CommonJS caller on a promised line loads the package without a
second build.
Bun, Deno and `workerd` read nothing else. A dual build would also give `StorageError` two
identities whenever both outputs end up in one graph: ADR 0005 branded the error under
`Symbol.for`, so matching on `code` survives that, but `instanceof` does not.

The five carry one version, as a `fixed` group in Changesets. ADR 0006 requires
`@stowage/conformance` to carry the version of `@stowage/core`, and extending that to the
adapters removes the question of whether `adapter-s3@0.4` runs against `core@0.6`. The price is a
release of `adapter-fs` that changed nothing, paid in 0.x against a compatibility matrix that
would otherwise have to be written down and tested.

This repository publishes nothing under the bare name `stowage`. An unrelated `stowage@0.5.0`
package was published on 2026-09-16 from an unrelated account, four days after this repository
became public, with a description close to this README and a `repository` field pointing at a
GitHub repository created two hours before the publish. ADR 0004 left no entry point for that
name anyway:
there is no facade and no manager, so an application that uses two adapters holds two values.

## Consequences

- pnpm workspaces, with `packages/*` published and `harness/*` private. The nested
  `node_modules` is what keeps ADR 0003's zero-dependency promise checkable: under a flat tree a
  package can import a hoisted development dependency and the build still passes.
- Each package builds with `tsdown`, which transpiles and does not check types, so `tsc --noEmit`
  is a step of its own. `isolatedDeclarations` is on, which makes `tsdown` emit declarations
  through `oxc-transform` and makes every exported signature written rather than inferred. The
  shared `tsconfig` also sets `strict`, `noUncheckedIndexedAccess`, `verbatimModuleSyntax` and
  `erasableSyntaxOnly`; the last one keeps the sources runnable by Deno, Bun and
  `node --experimental-strip-types` with no build in front of them.
- `tsdown` generates the `exports` map, and `publint` and `@arethetypeswrong/core` run inside the
  build rather than in CI, so a generated map is checked where it is produced.
- `oxlint` and `oxfmt` replace ESLint and Prettier. The type-aware rules come from
  `oxlint-tsgolint` and need the declarations of the other packages, so CI builds before it
  lints. `oxfmt` formats Markdown as well, which reformats the existing ADRs once.
- Vitest runs this repository's own tests, which sit beside the sources as `*.test.ts` and stay
  out of the tarball through `files: ["dist"]`, as does `docs/spec.md`. One of those tests is the
  check of ADR 0018, which compiles every `ts` block in a README and in the spec against the built
  declarations. The four conformance harnesses are private
  packages under `harness/`: the `workerd` one needs a worker entry point and Wrangler
  configuration, the Deno one a `deno.json`, and neither belongs in a published package.
- `ci.yml` runs on pull requests and on pushes to `main`: build, `tsc --noEmit`, lint, format
  check, then the `fast` conformance tier across the matrix of ADR 0002. `conformance-full.yml`
  runs the `slow` tier on a schedule, on demand and before every release, which is the split ADR
  0006 asks for. ADR 0012 names the endpoints those cells run against.
- Changesets keeps a version pull request open on `main`, and publishing runs from GitHub Actions
  through npm trusted publishing, so no npm token sits on a developer machine and every release
  carries provenance. No workflow requires a changeset on a pull request, because a change to an
  ADR has nothing to release.
- Renovate is enabled with development dependencies grouped into one weekly pull request.
  `tsdown`, `oxfmt` and `oxlint-tsgolint` are all below 1.0 and release often.
- `engines.node` is `>=24` and covers the Node floor alone. Bun and Deno ignore it and have no
  floor, as ADR 0002 states.
- `@stowage/adapter-s3-sdk`, which ADR 0003 names as the way back from the wire protocol, joins
  the same version group when it arrives.
