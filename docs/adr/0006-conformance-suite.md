# The conformance suite is a published package of plain cases

`@stowage/conformance` is published and carries the same version as `@stowage/core`, because the
claim that every adapter passes it — community adapters included — holds only if someone outside
this repository can run it. A private workspace package would contain the same code and none of
the commitment.

It exports an array of cases rather than a runner. A case carries `name`, `requires` and `cost`
beside the `run` and `runWithout` of ADR 0015, and a harness maps each one onto the test function
of its runtime: `describeConformance(target, { describe, test })` covers Vitest, `bun:test` and
`Deno.test`, whose signatures agree, without the package depending on any of the three. `workerd`
has no test function to give it, so there a worker calls
`runAll(target)` and serializes its result, which makes `ConformanceResult` published API rather
than an internal shape:

```ts
export interface ConformanceCaseMetadata {
  readonly name: string;
  readonly requires: readonly CapabilityName[];
  readonly cost: "fast" | "slow";
}

export interface SerializedConformanceError {
  readonly name: string;
  readonly message: string;
  readonly stack?: string;
  readonly code?: StorageErrorCode;
}

export type ConformanceMode = "declared" | "without";

export type ConformanceResult =
  | {
      readonly case: ConformanceCaseMetadata;
      readonly status: "passed";
      readonly mode: ConformanceMode;
    }
  | { readonly case: ConformanceCaseMetadata; readonly status: "skipped"; readonly reason: string }
  | {
      readonly case: ConformanceCaseMetadata;
      readonly status: "failed";
      readonly mode: ConformanceMode;
      readonly error: SerializedConformanceError;
    };
```

`runAll(target, options?)` returns `Promise<readonly ConformanceResult[]>`. It copies `name`,
`requires` and `cost` into `case` rather than returning the conformance case and its `run`
function. It also
normalizes a thrown value to `name` and `message`, adds `stack` when the value supplies one, and
adds `code` only for a recognized `StorageErrorCode`; it never exposes `cause` or the original
thrown value. The alternative was a single
`runConformance()` reporting a tree of its own, which produces one test under every framework,
and one red test is what someone debugging a third-party adapter learns nothing from.

An adapter supplies a `ConformanceTarget`: `name`, `createStorage()`, and optionally `cleanup()`,
`createStorageWithBadCredentials()` and `createStorageWithExpiredCredentials()`. Bucket management
is not in v0.1 (ADR 0004), so the suite cannot give a run a bucket of its own. A run generates one
`keyPrefix` instead, every case builds its keys below it, and `cleanup` defaults to
`deleteAll(keyPrefix)`, so two runs against one bucket leave each other alone — which is what a
shared CI bucket amounts to.

The suite asserts what the core API can observe, and nothing beyond it. Flow 1 requires that a
failed upload leaves no multipart upload behind, and the parity core has no operation that can
see one; flow 1 and flow 4 require that memory stays flat, and `workerd` offers no way to measure
it; ADR 0005 promises that a body stream breaking partway through `get` still arrives as a
`StorageError`, and provoking that means controlling the connection. Each of these becomes a test
of this repository against its own adapters rather than a case every adapter must pass. The rule
behind all three: the suite checks a promise, it does not prescribe a construction. Requiring an
inspection entry point on `ConformanceTarget` would reverse that, and every third-party adapter
would owe evidence for a promise its provider may not even make.

A case names the capability it requires and states itself what holds without it. A declaration
nobody checks is an assertion, and running the case either way checks it from both sides — whoever
declares `userMetadata` has to deliver it, and whoever does not has to refuse it. This resolves the
declaration left open by ADR 0004: `@stowage/core` publishes both the closed runtime list and its
derived name type:

```ts
export const capabilityNames = [
  "keyBytesPreserved",
  "presignedUrls",
  "rangeReads",
  "userMetadata",
] as const;

export type CapabilityName = (typeof capabilityNames)[number];
```

A storage carries its own declaration as `readonly CapabilityName[]`, listing each capability it
implements once, and ADR 0015 records why that is the only place it lives. The suite reads it once
per run, before the first case: a case whose `requires` names are all declared runs through `run`,
and one missing a name runs through `runWithout`, which for most of them asserts that the call
fails with `Unsupported`. Keeping the names closed beside `StorageErrorCode` serves the reason
ADR 0005 gives for that union: a suite that can only match on a message is the most fragile suite
there is.

`NotFound`, `InvalidKey`, `InvalidOption` and `Unsupported` are owed by every adapter, since any
adapter can be handed an absent or invalid key. `AccessDenied`, `InvalidCredentials` and `Expired`
depend on the optional credential factories, because ADR 0005 already records that `adapter-fs` has
no clock to be wrong about. Supplied, they are owed; absent, the case reports itself skipped with
its reason. Dropping those three codes from the suite was the alternative, and it would leave the
three-way split of S3's `403` — the part of ADR 0005 that took the most argument — unchecked in
every adapter this repository did not write.

## Consequences

- Cases are grouped by operation across the parity core, plus listing and pagination, range reads,
  streams, the error semantics and the declaration itself, which one case reads for published
  names and duplicates. Above them sit five cases carrying the names of the reference flows,
  without which the runtime matrix promises cells that nothing corresponds to. The cases
  themselves are enumerated in the spec, not here.
- A new case fails a third-party adapter that was green yesterday, so new cases land in minor
  releases only. A patch release of the suite may repair a case that was wrong and may not add
  one. ADR 0017 covers `ConformanceTarget` the same way, where a new required factory breaks a
  third-party adapter and an optional one does not.
- A case carries `cost: "fast" | "slow"`. `describeConformance(target, { describe, test })` and
  `runAll(target)` run fast cases by default; this remains the per-commit invocation. Scheduled
  and release CI must pass `includeSlow: true` —
  `describeConformance(target, { describe, test, includeSlow: true })` or
  `runAll(target, { includeSlow: true })` — to run both fast and slow cases. Listing past 1000 keys
  costs minutes and money against a real endpoint. Provoking a multipart upload does not: ADR 0016
  makes one part the threshold for a stream, so 17 MiB is enough and the case is a fast one. This
  explicit full-suite invocation is what ADR 0002 means by covered in CI, on all four runtimes,
  on a schedule and before every release. The slow cases may run less often; they may not run on
  fewer cells.
- No case names a runtime. Flow 5 has no `adapter-fs` target on
  `workerd`, because `adapter-fs` cannot be constructed there. A second copy of the matrix in code
  would drift from the one in ADR 0002 that carries the promise.
- Resource requirements become benchmarks on Node alone. The suite covers the observable half of
  them: bytes return unchanged, a range returns partial content, an abort reaches the provider.
- `adapter-memory` is not the reference implementation; the spec is. Cases are written against the
  behavior S3 shows, not against what is convenient in memory, because S3 is the side that cannot
  be changed.
- `AccessDenied` needs a third optional factory, `createStorageWithDeniedCredentials()`: a
  credential the provider accepts that may read the bucket and not write to it. A wrong secret and
  an expired token both fail authentication, so neither of the other two factories can produce a
  `403` that means the caller may not do this, and ADR 0005 counts a code the suite cannot exercise
  as a claim the implementation does not keep.
- There is no registry of adapters that pass, no badge and no way to mark a case as an accepted
  failure. Whoever passes says so in their own README. A declared deviation is a capability left
  undeclared, which the case's `runWithout` already covers. Where the endpoint a harness runs
  against answers differently from S3 itself, ADR 0012 keeps that divergence in the harness,
  outside this package.
