# Six READMEs point into one living spec

ADR 0017 made the spec the contract: what a caller may rely on is what it states, not what
TypeScript happens to export. That settles where a promise is written, and it leaves the second
text with nothing to say. A README that also states a promise is a second contract with no rule
for which of the two holds, so v0.1 writes each promise once, in the spec, and gives the README
the job of getting a reader there.

The spec covers all five packages of ADR 0008 rather than the parity core alone. `adapter-fs`
refusing a path segment longer than 255 bytes (ADR 0010) and the four response overrides on
`presignGet` (ADR 0014) are promises like any other. A spec that stopped at the parity core would
leave them to the package that implements them, and the contract would then sit in six files.

The file loses its version number: `docs/spec/v0.1.md` becomes `docs/spec.md`, and it describes
the version that is current rather than the version it was written for. A frozen `v0.1.md` beside
a later `v0.2.md` is a second text to keep correct, and ADR 0017 promises no support window for an
older line, so nobody is entitled to read the older one. The history is the git tag, and what
changed between two versions is the changelog. The README of each package therefore links the spec
at the tag of the release it belongs to, not at `main`: a caller holding `0.3.0` who follows a link
to `main` reads promises that `0.5.0` made.

v0.1 ships no documentation site. Success is the author using stowage and a handful of others
finding it, so a site is a second place to deploy and a second text to hold against the spec. There
is no `examples/` workspace either: five programs nobody runs go stale, and the five reference flows
of ADR 0004 are already carried twice, as prose in the spec that justifies the surface and as cases
in the conformance suite.

What a README does carry, it carries in a fixed order, so that a reader who has seen one knows where
to look in the next. `@stowage/conformance` is the exception, because it is the entry point for
someone writing an adapter outside this repository and needs the steps of that job instead.

## Consequences

- Six READMEs: one at the repository root and one per published package. The root README sells the
  project and shows the package family; `@stowage/core` describes a package that does nothing
  without an adapter. They are not the same text.
- The root README opens with two blocks: the same four calls against `adapter-fs` and against
  `adapter-s3`, differing only in how the storage is constructed, which is the opening sentence of
  `CONTEXT.md` written as code. Reference flow 1 follows as the second example.
- `@stowage/core`, `@stowage/adapter-memory`, `@stowage/adapter-fs` and `@stowage/adapter-s3` share
  the same sections in the same order: install, one example, runtimes, limits, notes, and the link
  into the spec. A section is present even when it is empty, where it says so.
- Runtimes names what the package declares, the Bun and Deno versions CI last ran green (ADR 0002)
  and the measured bundle size (ADR 0003). Limits holds the points where the package keeps a
  promise of the parity core weakly or refuses a call, each beside a link into the spec passage
  that fixes it: the capabilities it does not declare, the path segment `adapter-fs` refuses (ADR
  0010), and NFD on APFS against R2 normalizing to NFC (ADR 0014 and ADR 0015). Notes holds what a
  caller has to write themselves: splitting a connection string into `bucket`, `region`, `endpoint`
  and `credentials` (ADR 0007), `blob.stream()` for a caller holding a `Blob`, and the byte counter
  written as a `TransformStream` in front of `put` (ADR 0016). Naming R2's normalization in the
  text does not take the blindness ADR 0014 gave the adapter, which governs what the code does with
  a provider and not what a reader is told.
- A divergence keeps the meaning ADR 0012 gave it, a named difference between the emulator and the
  provider it stands in for, and no README carries one.
- `@stowage/conformance` has a shape of its own: how to build a `ConformanceTarget`, how the
  declaration of ADR 0015 is filled, how the cases reach a test framework, and what `runAll()` is
  for on `workerd`. It names `adapter-memory` as the implementation to read, which is what ADR 0008
  published it separately for.
- Every `ts` code block in a README and in the spec is type-checked by a test in this repository,
  which extracts the blocks and compiles them against the built declarations. Links are not
  checked: a wrong block teaches something false, a dead link costs a search.
- Exported signatures carry TSDoc where the meaning was decided rather than named: the ten error
  codes of ADR 0005, the capability names of ADR 0015, `retry`, `concurrency`, and the fields whose
  bounds an ADR fixed. `put(key, body)` gets none.
- `docs/spec.md` stays out of the published tarballs, which keep the `files: ["dist"]` of ADR 0008.
  Shipping it would place five copies of a living text at a version that cannot be corrected, while
  the link at the tag names the one that belongs to the installed code.
- `SECURITY.md` at the root states what ADR 0017 promises and withholds: report through GitHub
  private vulnerability reporting, a fix in the current line, no backport, no stated deadline. No
  `CODE_OF_CONDUCT.md` and no issue templates for v0.1; one maintainer is not an enforcement body,
  and templates wait for issues from outside.
- `CONTEXT.md` is read by callers, not only by this project. The spec links it for the terms it
  uses instead of defining them a second time.
- The npm name collision of ADR 0008 is answered by the `description` and `keywords` of the five
  packages alone. Disputing the name costs correspondence a side project cannot spend, and renaming
  costs five package names and seventeen decisions.
- Documentation outside the spec is not part of the release contract. A README line that disagrees
  with the spec is corrected without a changeset and reaches npm with the next release. The spec
  itself follows ADR 0017: editorial where the promise is unchanged, a minor release where it is
  not.
- The READMEs are written by the first build session, out of the obligations the spec names. They
  need install lines, import paths and an example for packages that do not exist yet.
