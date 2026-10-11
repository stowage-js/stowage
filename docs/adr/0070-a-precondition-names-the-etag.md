# A precondition names the `etag`, which is the generation on adapter-gcs

v0.7 lets `put`, `delete` and the destination of `copy` and `move` carry a precondition: "only if
the key holds no object" or "only if the object is the one the caller read". The map of the effort
(#435) settled the two kinds, the operations, a `StorageError` rather than a result value, and that
what a precondition names is read from an `ObjectStat` stowage handed over. This records the shape
(#440), from what AWS S3, R2, Azure Blob and GCS were measured to do
(`docs/research/provider-preconditions.md` on `research/provider-preconditions`) and from what
other portable libraries chose (`docs/research/precondition-prior-art.md` on
`research/precondition-prior-art`).

A precondition names the `etag`. AWS, R2 and Azure check `If-Match` against the bare `etag`
`ObjectStat` already reports, after a single `PUT`, a multipart commit and a copy alike. GCS checks
the generation alone: the JSON API ignores `If-Match` on an upload and replaces the object, and a
`PATCH` of the content headers or user metadata alone moves the JSON `etag` while it keeps the
generation. So `adapter-gcs` reports the generation as `etag`, on `put`, `stat`, `get`, `copy`,
`move` and every `ObjectEntry` of a listing, all of which GCS answers with `generation`. A separate
opaque member, equal to the `etag` on three providers and to the generation on GCS, was the
alternative. It would give `ObjectStat` two members that mean almost the same thing, and
`@stowage/http` would have to pick one: it sets `ETag` from `etag`, a browser sends that value back
as `If-Match`, and `acceptUpload` taking the client's `If-Match` is part of the destination. Either
`ETag` would stop being `etag`, or the layer would look up the generation of a client's `ETag` with
a `stat` in front of the write, which is the race a precondition exists to close. A generation is a
strong validator under RFC 9110: it changes whenever the bytes a `200` carries change.

Reporting the generation withdraws a promise of a released adapter, which conflicts with ADR 0017.
`etag` on `adapter-gcs` stops being the `etag` GCS itself reports, and a change another tool makes
to the content headers or user metadata no longer moves it. RFC 9110 lets a strong validator change
on such a change so that caches let go of the old headers; the generation does not, so
`serveObject` may answer `304` to a client whose cached content headers are older than the
object's. The value was always promised opaque, and nothing stowage writes changes the content
headers of an object that exists. The changeset starts with `**Breaking:**`.

One option carries either kind: `onlyIf: "absent" | { etag: string }`, on `PutOptions` and on a new
`CopyOptions` that `copy` and `move` take and that applies to `to`. The two kinds exclude each
other, and a union cannot hold both, where two options would need a rule against setting both. The
HTTP names `ifNoneMatch` and `ifMatch` were the alternative. They invite `ifNoneMatch: "<tag>"` on a
write, which the map ruled out, and they promise RFC 9110's list of tags, which an `etag` stowage
handed over never needs. Taking an `ObjectStat` itself, as OpenDAL's `if_not_changed` does, fails on
the optional `etag` and leaves `@stowage/http` nothing to pass for a client's header. A `move` whose
destination precondition fails rejects before it deletes anything, so `from` stays.

`delete` gains an overload for one key: `delete(key, options: DeleteOptions)`, where
`DeleteOptions` extends `OperationOptions` with an optional `onlyIf: { etag: string }`. "Absent"
means nothing on a delete: the type leaves it out, and at run time it is `InvalidOption`. The
variadic form stays as it is and never carries a precondition, so a conditional delete is one
request and never part of a batch: R2 drops the per-key `<ETag>` of `DeleteObjects` in silence, and
a precondition concerns the one object a caller read. The overload resolves with a `DeleteReport`
like the variadic form, and a failed precondition is an entry in `failed`, as every per-key failure
is (spec 4.7). `delete(key, { signal })` without `onlyIf` is legal, so the one form of `delete`
with room for a signal takes it. A storage that implements `delete` with the variadic signature
alone is no longer assignable to `Storage`, so the overload breaks every third-party adapter at
compile time, which ADR 0017 counts as a break; per-key entries in the variadic form or a method of
its own on `Storage` would break it alike. The changeset starts with `**Breaking:**` for adapter
authors.

A failed precondition is one new `StorageErrorCode`, `PreconditionFailed`, with `retryable: false`,
on either kind and every operation. The caller knows which kind it sent, so a second code would
carry nothing the call does not. `object_store` splits `AlreadyExists` from `Precondition`, which in
stowage's shape is that same knowledge. "Unchanged" against a key that holds no object is
`PreconditionFailed` too, not `NotFound`. On a write, R2, Azure and GCS answer it `412` and cannot
tell a gone object from a changed one, while AWS answers `404`; a delete answers `404` on AWS, Azure
and GCS, and one code keeps the outcome alike across operations and providers. `status` and
`providerCode` carry what the provider answered, such as Azure's `409 BlobAlreadyExists` for a key
that is not free.

Three capabilities follow the two lines the measurements drew. `writeIfAbsent` covers "absent" on
`put` and the destination of `copy` and `move`, which `adapter-fs` can hold atomically.
`writeIfUnchanged` covers "unchanged" there, which no file system holds. `deleteIfUnchanged` covers
the overload, which R2 does not hold and which `adapter-s3`, blind to its provider under ADR 0014,
cannot tell apart. One capability for everything would leave `adapter-fs` declaring nothing; a
capability per kind and operation draws lines no provider showed an adapter unable to bridge.

Where a storage does not declare the capability an `onlyIf` needs, the call is `Unsupported` naming
it, whatever the value. A value of the wrong form comes after that and is `InvalidOption` naming
`onlyIf`, never its value. Both come before signing, with `attempts: 0`, and leave the key as it
was. `onlyIf: undefined` is no precondition. The inverted conformance case asserts exactly that: a
call carrying `onlyIf` on a storage without the capability is `Unsupported` naming it with
`attempts: 0`, and the key afterwards holds what it held, or nothing where it held nothing. No path
drops a precondition in silence. A third-party adapter that does not know `onlyIf` refuses it as an
unknown option under spec 4.3 and fails the new cases, which ADR 0006 prices at a minor; that rule
is what keeps an adapter from ignoring the option.

The `etag` in `onlyIf` is a non-empty string of visible ASCII without `"` and without a leading
`W/`; anything else is of the wrong form. A well-formed `etag` that cannot match is
`PreconditionFailed`, as the provider would answer it: a value that is no generation never matches
on GCS, so `adapter-gcs` refuses it without a request and with `attempts: 0`. Making it
`InvalidOption` would have every adapter promise the form of its `etag`, which opaque rules out.

Where a storage declares `writeIfUnchanged` or `deleteIfUnchanged`, `etag` is promised: it is set on
every `ObjectStat` and every `ObjectEntry` of a listing, the `etag` a write resolves with is the one
a later `stat` reports, and a precondition naming it holds as long as nothing writes to the key. A
write that changes the bytes changes the `etag`. A write of the same bytes may keep it, as S3's MD5
and `adapter-memory`'s SHA-256 do, or change it, as Azure and GCS do, so no storage promises to
catch a rewrite of the same bytes. Whether a change another tool makes to the content headers or
user metadata moves the `etag` is not promised either: it does on Azure and no longer does on GCS.
`exists` says nothing about an `etag`: `exists` followed by `put` is the race `onlyIf: "absent"`
closes.

## Consequences

- Spec 4.1 gains the `delete` overload and loses the sentence that `delete` has no room for a
  signal; 4.3 `onlyIf`, `CopyOptions`, `DeleteOptions` and the order of the checks; 4.4 the
  promise on `etag`; 4.7 the entry a failed precondition leaves; 4.9 the three capabilities; 4.10
  `PreconditionFailed`; 4.11 the conditional forms of `put`, `delete`, `copy` and `move`. The
  sentence that no operation is conditional goes, and whether the concurrent-writers promise beside
  it changes stays on the map.
- Spec 9 has `adapter-gcs` report the generation as `etag`, and spec 10 notes what that means for
  `ETag` and `304` on GCS.
- The new options, `CopyOptions`, `DeleteOptions`, the code and the capabilities are additions. The
  `etag` of `adapter-gcs` and the `delete` overload each take something from someone, callers of
  `adapter-gcs` and authors of adapters, and each carries `**Breaking:**`.
- Which adapter declares which capability, how each maps the provider's answers, and what reaches
  spec 18 are decided in #441 and #442. A conditional `delete` never batches, so #441 has no batch
  to decide.
- What a repeat after a lost answer does (#443), a presigned upload's precondition (#444), and how
  `acceptUpload` takes one from a request (#445) stay with their tickets.
