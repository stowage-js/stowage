# The spec is the contract, and every change to it is a minor release until 1.0

A patch release repairs code that disagrees with the spec. Every other release is a minor, whether
it adds to the spec or takes something out of it. npm resolves `^0.3.1` to `>=0.3.1 <0.4.0`, so
below 1.0 the minor is already the boundary the major becomes afterwards, and a caret range holds a
caller on one line until they decide otherwise. ADR 0006 had reserved the minor for a new
conformance case and forbidden the patch to add one; the rest of the surface follows that split.
Treating an addition as a patch would deliver it to every caret range in existence, and 0.x is
where the surface still moves.

What a caller may rely on is what `docs/spec.md` states, not what TypeScript happens to
export. The numbers ADR 0013 and ADR 0016 declare unreliable — 100 milliseconds and five seconds
of backoff, 8 MiB parts, four parts in flight — move in a minor release and never in a patch.
Unreliable is not unannounced: a patch that raised the part size to 64 MiB would exhaust the memory
of a Worker whose code nobody had touched.

A change only the compiler sees counts like a change in behavior, because a caller whose build
stops is stopped either way: an exported signature, the TypeScript floor, a declaration written
differently under `isolatedDeclarations`. One exception, stated here rather than claimed on the day
it is needed: exhaustiveness over a closed union. `StorageErrorCode` of ADR 0005 and
`capabilityNames` of ADR 0015 both break a `switch` without a default branch as soon as a name
joins them. What stowage promises is that a published name keeps its meaning, not that the list
keeps its length. Azure and GCS will bring codes of their own, and a major release for each of them
would fix the taxonomy for the life of 1.x in order to protect a `switch` that a default branch
already protects. A name is added in a minor release, after 1.0 as well as before.

A provider promised later does not narrow the parity core either. ADR 0014 defines it as what every
promised provider holds, which read on its own would let a third provider take a promise away from
callers who have it today — the opposite direction from dropping a runtime, which ADR 0002 already
calls harmless. What the new provider cannot hold becomes a capability its adapter does not
declare, the shape ADR 0015 built for `keyBytesPreserved`: a promise the parity core makes weakly
instead of one it stops making. Narrowing it is a breaking change where a difference refuses that
shape, and dropping a promised provider is not. The capability list grows with each provider, which
the paragraph above already prices at a minor.

Corrections run in two directions and cost differently. A promise that the first run against a real
endpoint disproves — ADR 0012 leaves three of them open, ADR 0014 the response overrides on
`presignGet`, ADR 0016 the `UploadPartCopy` fallback — is withdrawn in a minor release, because
the spec is the contract and taking something out of it takes it from the caller whether or not a
line of code moves. Code that disagrees with the spec is repaired in a patch however long it has
been published: behavior the spec never promised was never a promise, and weighing how long
someone may have depended on it asks for knowledge about strangers that nobody has.

1.0 waits for six things:

- The three points ADR 0012 leaves unverified against every candidate endpoint — `EntityTooSmall`,
  what a presigned `PUT` binds, and `HEAD` without a body — have run against a real one. The
  first scheduled run met this.
- The four response overrides on `presignGet` have run against a real R2 bucket instead of staying
  provisional (ADR 0014). The first scheduled run met this.
- The `UploadPartCopy` fallback of ADR 0016 has run against a real endpoint rather than against
  stubbed `fetch`, which is the one promise of v0.1 no CI run checks.
- The CPU and the duration a large upload spends on `workerd` are measured, so reference flow 1 on
  Workers is promised or ruled out instead of left open (ADR 0002). The first scheduled run met
  this, and flow 1 is promised.
- The `raw` escape hatch has a shape.
- The author has used stowage in a project of their own, which is the one item no measurement
  settles.

In return 1.0 promises that a breaking change costs a major release, and that a minor marks with
`@deprecated` what a later major removes. It promises no support window and no security fixes for
an older line: a side project with no deadline cannot keep a schedule, and a promise that breaks
the first time a month fills up is worse than no promise.

## Consequences

- No `major` changeset is written below 1.0. Changesets hands the bump type to `semver.inc`, which
  turns 0.4.2 into 1.0.0, and it has no option that keeps a major inside 0.x; the fixed group of
  ADR 0008 would take the other four packages along. 1.0.0 is that one changeset, written on
  purpose.
- A changeset for a breaking change starts with `**Breaking:**`. The default changelog groups by
  bump type alone, so below 1.0 a break and an addition share the "Minor Changes" section, and
  ADR 0002, ADR 0013 and ADR 0016 each promise that a change of theirs leads its entry.
- Dropping a runtime, or a Node line that reached end of life, stays outside the contract after 1.0
  as well. `engines` and the changelog carry it, and making it a major would let another project's
  end-of-life calendar decide stowage's version number.
- Nothing is deprecated before it is removed below 1.0. A deprecation round costs a release cycle
  and addresses callers this project does not know it has.
- There is no pre-release channel. 0.x is one, and the `pre` mode of Changesets would put all five
  packages into a state that has to be left again; a snapshot release before 1.0.0 is an act rather
  than a policy.
- `ConformanceTarget` is covered like every other export, so a new required factory breaks a
  third-party adapter and an optional one does not. ADR 0006 governs the cases alone, and the
  adapters outside this repository are the group the suite exists for.
- Tightening the key rule of ADR 0010 costs a minor release below 1.0 and a major above it.
  Loosening it costs neither.
- `docs/spec.md` states the rule without the reasoning, so a caller learns what a version
  number means without reading this. It is the only text of this project the contract covers: ADR
  0018 keeps the READMEs outside it, where a correction costs no changeset.
- ADR 0028 amends the list of six things 1.0 waits for: in place of the four measured points, 1.0
  waits until section 13 of the spec holds no promise a real endpoint has not answered. The
  `raw` escape hatch and the author's own use stay.
