# Every storage declares its capabilities at runtime

A storage carries `readonly capabilities: readonly CapabilityName[]` on the portable type, and it
is the only place the declaration lives. `ConformanceTarget` no longer supplies one: the suite
reads it from the storage it creates. Two copies of the same declaration can disagree, and an
adapter that tells the suite one thing and the application another is exactly what ADR 0006
inverts a case to catch. The names stay the closed set that ADR 0006 published, which keeps the
declaration on the portable type without reopening the closed core of ADR 0004.

The declaration is read at runtime and nowhere else. A generic `Storage<Caps>` would make an
unsupported call a compile error, and it would bring back the type parameter ADR 0004 closed the
core against: an application that wants to stay portable would write `Storage<CapabilityName>` and
have moved the decision rather than made it. The one capability that needs an answer from the
compiler has one already, because ADR 0011 keeps `presignGet` and `presignPut` on the concrete
adapter type. `presignedUrls` still appears in the array there, although a caller holding
`Storage` finds no method behind it: a suite that read the method's presence instead would be
checking the implementation against itself, and a declaration only means something while it is
separate from what it describes.

A call that reaches a part of the parity core the adapter does not support fails with
`Unsupported`, and the error names the capability in a `capability` field of its own, added to
`StorageError` in ADR 0005. `put` on `adapter-fs` throws when `userMetadata` is present and holds
at least one entry; `undefined` and `{}` pass, so a caller moving a prefix from one adapter to
another does not have to strip an empty object out of the options it forwards. Silently dropping
the metadata was the alternative and is the one failure the caller never sees: the write succeeds,
the read comes back empty, and the loss surfaces in production. Emulating it in a sidecar file was
ruled out by the reference flows of ADR 0004, which read buckets other tools wrote.

Reading asks nothing an adapter cannot answer, so the other direction never throws. `get` and
`stat` return `userMetadata` as an object on every adapter, empty where the capability is absent.
An optional field would give every caller a `?? {}` that means nothing else, and `adapter-fs`
holding no metadata is a fact about the object rather than a refusal.

A capability belongs to the storage, not to the adapter class, and is fixed when the storage is
constructed. Configuration can decide it, which the adapter class cannot see. The runtime cannot:
ADR 0002 already governs where an adapter exists at all, and a capability that held on Node and
not on Bun would be a defect rather than something to declare.

`keyBytesPreserved` joins the three published names and carries what ADR 0010 left open. A key
whose Unicode form survives a round trip byte for byte is not something an adapter offers on top
of the parity core; it is a promise the parity core makes weakly, because two adapters cannot make
it strongly. The case without the capability therefore asserts the weaker promise — the key comes
back Unicode-equivalent — rather than a call that fails, which is why the inversion rule moved
into the cases below. In v0.1 only `adapter-memory` declares it: `adapter-fs` returns NFD on APFS,
and `adapter-s3` is blind to its provider under ADR 0014, so it cannot declare against R2 what
holds against S3. The value of the name is in what a third-party adapter can claim and in making
the weak promise checkable at all — without it the suite has one case, and no adapter can ever
show that it holds more. Declaring it by probing the file system at construction, or by an option
in which the caller asserts something about a disk they have not measured, both cost more than the
stronger case is worth, so `adapter-fs` stays silent on `ext4` too.

What holds without a capability is stated by the case rather than by the framework:

```ts
export type ConformanceCase =
  | {
      readonly name: string;
      readonly requires: readonly [];
      readonly cost: "fast" | "slow";
      run(ctx: ConformanceContext): Promise<void>;
    }
  | {
      readonly name: string;
      readonly requires: readonly [CapabilityName, ...CapabilityName[]];
      readonly cost: "fast" | "slow";
      run(ctx: ConformanceContext): Promise<void>;
      runWithout(ctx: ConformanceContext): Promise<void>;
    };
```

`ConformanceContext` carries the storage, the run's `keyPrefix` and `declares(name)`. The suite
picks `run` where every required name is declared and `runWithout` where one is missing, so a case
about a capability always runs and `ConformanceResult` gains `mode: "declared" | "without"` to say
which half was checked. One rule for all of them stopped fitting once there were two exceptions to
it: presigning has no call to fail, and `keyBytesPreserved` has no failure at all. Attaching the
kind of inversion to the capability name instead was the other shape, and the kind is not a
property of the name — the same missing `keyBytesPreserved` weakens a round-trip case and a
listing case in two different ways. The ordinary case stays one line, because
`@stowage/conformance` exports `expectUnsupported`, which runs a call and asserts a `StorageError`
with `code: "Unsupported"` and the expected `capability`.

The declaration is read once per run, before the first case, and a target promises that every
storage it creates in that run declares the same. A run that reported which cases it inverted
after inverting them could not be read as a statement about one adapter. One case of its own, in
the `fast` tier and requiring nothing, asserts that `capabilities` holds only published names and
each of them once: a typo in a name would otherwise invert a whole group of cases, and the adapter
would pass because its calls all fail correctly.

## Consequences

- v0.1 declares: `adapter-s3` `presignedUrls`, `rangeReads` and `userMetadata`; `adapter-fs`
  `rangeReads`; `adapter-memory` `rangeReads`, `userMetadata` and `keyBytesPreserved`.
- An application can ask any storage what it supports, and for `presignedUrls` the answer does not
  give it a method. Reaching the presign methods means naming the concrete adapter type, which
  ADR 0004 already makes the visible act at the call site.
- `capabilityNames` is closed like `StorageErrorCode`, so a fifth name breaks a caller that
  switches over it exhaustively. ADR 0017 leaves that switch outside the contract and adds the name
  in a minor release.
- A third-party adapter with a feature stowage has no name for declares nothing and puts the
  feature on its own concrete type. The suite has nothing to run against it, which is the same
  position ADR 0006 takes for a deviation.
- `adapter-fs` fails `put` with `userMetadata`, so the reference flow that moves a prefix from
  `fs` to S3 reads no metadata to carry and the flow in the other direction loses it at the
  boundary rather than in the object.
- The content type on `adapter-fs` is a promise kept weakly without a capability name. The
  adapter derives the type from the key's extension on every read and stores nothing, because a
  sidecar file was ruled out with user metadata, so `stat` may answer a type other than the one
  `put` was given. `keyBytesPreserved` is the shape for it, and the name waits until a second
  adapter shows the same limit; the spec states it under the adapter and the conformance case for
  the content type uses a key whose extension agrees with it.
- The core exports no guard the adapters call. An adapter knows without asking what it does not
  support, and a function wrapping `capabilities.includes()` would move nothing; what the core
  owns is the error, so the code, the message and the `capability` field are the same everywhere.
