# The conformance suite is a published package of plain cases

`@stowage/conformance` is published and carries the same version as `@stowage/core`, because the
claim that every adapter passes it — community adapters included — holds only if someone outside
this repository can run it. A private workspace package would contain the same code and none of
the commitment.

It exports an array of cases rather than a runner. A case is `{ name, requires, cost, run }`, and
a harness maps each one onto the test function of its runtime: `describeConformance(target, { describe, test })`
covers Vitest, `bun:test` and `Deno.test`, whose signatures agree, without the package depending
on any of the three. `workerd` has no test function to hand over, so there a worker calls
`runAll()` and serializes `ConformanceResult[]` — `{ case, status, reason, error }` — which makes
that result published API rather than an internal shape. The alternative was a single
`runConformance()` reporting a tree of its own, which produces one test under every framework,
and one red test is what someone debugging a third-party adapter learns nothing from.

An adapter supplies a `ConformanceTarget`: `name`, `capabilities`, `createStorage()`, and
optionally `cleanup()`, `createStorageWithBadCredentials()` and
`createStorageWithExpiredCredentials()`. Bucket management is not in v0.1 (ADR 0004), so the suite
cannot give a run a bucket of its own. A run generates one `keyPrefix` instead, every case builds
its keys below it, and `cleanup` defaults to `deleteAll(keyPrefix)`, so two runs against one
bucket leave each other alone — which is what a shared CI bucket amounts to.

The suite asserts what the core API can observe, and nothing beyond it. Flow 1 requires that a
failed upload leaves no multipart upload behind, and the parity core has no operation that can
see one; flow 1 and flow 4 require that memory stays flat, and `workerd` offers no way to measure
it; ADR 0005 promises that a body stream breaking partway through `get` still arrives as a
`StorageError`, and provoking that means controlling the connection. Each of these becomes a test
of this repository against its own adapters rather than a case every adapter must pass. The rule
behind all three: the suite checks a promise, it does not prescribe a construction. Requiring an
inspection entry point on `ConformanceTarget` would reverse that, and every third-party adapter
would owe evidence for a promise its provider may not even make.

A case names the capability it requires. Where the adapter does not declare it, the suite inverts
the case: the call must fail with `Unsupported`. A declaration nobody checks is an assertion, and
inverting checks it from both sides — whoever declares `userMetadata` has to deliver it, and
whoever does not has to refuse it. The capability names are a closed set in `@stowage/core`,
beside `StorageErrorCode` and for the reason ADR 0005 gives for that union: a suite that can only
match on a message is the most fragile suite there is. How an adapter declares them, and whether
the declaration is also visible in the types, is decided separately.

`NotFound`, `InvalidKey`, `InvalidOption` and `Unsupported` are owed by every adapter, since any
adapter can be handed an absent or invalid key. `AccessDenied`, `InvalidCredentials` and `Expired`
hang on the optional credential factories, because ADR 0005 already records that `adapter-fs` has
no clock to be wrong about. Supplied, they are owed; absent, the case reports itself skipped with
its reason. Dropping those three codes from the suite was the alternative, and it would leave the
three-way split of S3's `403` — the part of ADR 0005 that took the most argument — unchecked in
every adapter this repository did not write.

## Consequences

- Cases are grouped by operation across the parity core, plus listing and pagination, range reads,
  streams and the error semantics. Above them sit five cases carrying the names of the reference
  flows, without which the runtime matrix promises cells that nothing corresponds to. The cases
  themselves are enumerated in the spec, not here.
- A new case fails a third-party adapter that was green yesterday, so new cases land in minor
  releases only. A patch release of the suite may repair a case that was wrong and may not add
  one. Inside 0.x this means a conformance case does not force a major.
- A case carries `cost: "fast" | "slow"`, and `describeConformance` runs the fast ones by default.
  Listing past 1000 keys and uploading past the single-`PUT` limit cost minutes and money against
  a real endpoint. This refines ADR 0002: covered in CI means the full set, on all four runtimes,
  on a schedule and before every release. The slow cases may run less often; they may not run on
  fewer cells.
- No case names a runtime. Flow 5 has no target on `workerd`, because `adapter-fs` cannot be
  constructed there, and flow 1 on `workerd` is one named exclusion in that harness. A second copy
  of the matrix in code would drift from the one in ADR 0002 that carries the promise.
- Resource requirements become benchmarks on Node alone. The suite covers the observable half of
  them: bytes return unchanged, a range returns partial content, an abort reaches the provider.
- `adapter-memory` is not the reference implementation; the spec is. Cases are written against the
  behavior S3 shows, not against what is convenient in memory, because S3 is the side that cannot
  be changed.
- There is no registry of adapters that pass, no badge and no way to mark a case as an accepted
  failure. Whoever passes says so in their own README. A declared deviation is a capability left
  undeclared, which the inverted case already covers.
