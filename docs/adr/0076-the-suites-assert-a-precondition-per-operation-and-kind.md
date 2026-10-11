# The suites assert a precondition per operation and kind, and leave the lost answer to the repository

ADR 0070 to ADR 0075 gave `put`, `delete`, the destination of `copy` and `move`, `presignPut`,
`presignUpload` and `acceptUpload` their preconditions, and each left to this decision what the
conformance suite (spec 14.5) and the HTTP conformance suite (spec 14.9) assert of them (#446).
This records the new cases, their tier and capability, their halves without it, which endpoints
run them, the existing cases that stay, and what stays a test of this repository.

The line is the one ADR 0064 drew. A case asserts what the core API lets a caller observe through
what a case can do: write through the storage, and send a request with `fetch`. A lost answer is
outside that, since no case can make an endpoint drop one, and so is a route configured otherwise
than spec 14.8 fixes it. Everything else the preconditions promise becomes a case.

## `put`, `copy`, `move` and `delete`

One case per operation and kind, each `fast`. `put` has a second case per kind on a 17 MiB
stream, because that is a commit path of its own on every cloud adapter
(`CompleteMultipartUpload`, `Put Block List`, the resumable commit), and the emulators and R2
differ per path.

- `put/if-absent` and `put/if-absent-multipart` require `writeIfAbsent`. A free key is written; a
  key that holds an object rejects with `PreconditionFailed` and holds what it held.
- `put/if-unchanged` and `put/if-unchanged-multipart` require `writeIfUnchanged`. The `etag` of
  `stat` holds and the `ObjectStat` of the write carries another; that `etag`, stale after a second
  `put`, and an `{ etag }` on a key that holds no object each reject with `PreconditionFailed`, not
  `NotFound`.
- `copy/if-absent` and `move/if-absent` require `writeIfAbsent`, `copy/if-unchanged` and
  `move/if-unchanged` `writeIfUnchanged`. They assert what the `put` cases assert, on the
  destination; a `move` refused at its destination leaves `from` in place. The `if-unchanged` cases
  also have a missing source beside a destination whose `etag` holds reject with `NotFound` and not
  `PreconditionFailed`, which is the `<Key>` rule of ADR 0071 on AWS.
- `delete/if-unchanged` requires `deleteIfUnchanged`. A current `etag` reports `requested: 1` and
  an empty `failed`, and the key is gone; a stale `etag` and a key that holds no object each leave
  one `PreconditionFailed` entry with that `key` in `failed`, and the object stays.
  `onlyIf: "absent"` rejects with `InvalidOption`.
- `delete/options` requires nothing: `delete(key, {})` deletes, and a signal already aborted
  rejects with `AbortError`.

Every half without its capability asserts ADR 0070: the call carrying `onlyIf` rejects with
`Unsupported` naming the capability, `attempts: 0`, and every key it names holds what it held, or
nothing where it held nothing.

A `PreconditionFailed` is asserted with `retryable: false` and `attempts: 1`, as `get/missing-key`
asserts its `NotFound`; with `operation` the operation called, `move` for a `move`; and with `key`
the key that carries the precondition, `to` for `copy` and `move`. `status` and `providerCode` are
not asserted: Azure answers `409` where the others answer `412`, and `adapter-memory` carries
neither. `errors/shape` covers the new errors as it covers every error a run provokes.

The repeat after a lost answer (ADR 0073) and the conditional `move` finished with `delete(from)`
are no cases, since a case cannot provoke the lost answer either rests on. They are tests against a
stubbed `fetch`, where ADR 0013 puts the rest of the loop.

## A value of no kind

ADR 0070 has a storage without the capability an `onlyIf` needs refuse it as `Unsupported` naming
it, whatever the value, and a value of the wrong form be `InvalidOption` after that. It does not
say which capability a value needs that is neither kind, such as `onlyIf: 42`, and the halves
without the capability need to know. The form decides the kind: a string is "absent" and needs
`writeIfAbsent`, an object is "unchanged" and needs `writeIfUnchanged`, or `deleteIfUnchanged` on
`delete`, and any other value is `InvalidOption` naming `onlyIf` on every storage. So
`onlyIf: "present"` is `Unsupported` naming `writeIfAbsent` on a storage without it and
`InvalidOption` on one with it, and `{ etag: 'W/"x"' }` is `Unsupported` naming
`writeIfUnchanged` on `adapter-fs` and `InvalidOption` on `adapter-memory`. This adds to ADR 0070
what it left open and changes nothing it decided.

The `if-unchanged` cases assert the form of the `etag` in their half with the capability: `""`, one
holding `"`, one with a leading `W/` and an `etag` that is no string each reject with
`InvalidOption` naming `onlyIf`, `attempts: 0`, and leave the key as it was. `put/only-if-no-kind`
requires nothing and has `onlyIf: 42` and `onlyIf: null` reject with `InvalidOption` on every
storage.

## The promise on `etag`

`stat/etag-promised` requires `writeIfUnchanged` and asserts ADR 0070's promise: `etag` is set on
the `ObjectStat` of `put`, `stat`, `get`, `copy` and `move` and on every entry of a listing, the
`etag` of `put` is the one a later `stat` reports, and a write of other bytes changes it. Its half
without the capability asserts nothing about `etag`, which no storage promises there; it writes
and reads back.

ADR 0070 promises `etag` where `writeIfUnchanged` or `deleteIfUnchanged` is declared, and
`requires` names capabilities that must all be declared. No adapter declares `deleteIfUnchanged`
without `writeIfUnchanged`; for one that would, `delete/if-unchanged` asserts `etag` on the `stat`
it reads its precondition from.

## Concurrent writers

`put/concurrent-if-absent` has two `put`s of small bodies with `onlyIf: "absent"` race for one
free key: exactly one resolves, the other rejects with `PreconditionFailed`, and `get` returns the
bytes of the one that resolved. `put/concurrent-if-absent-multipart` does the same with two
17 MiB streams paced as `put/concurrent-writers` paces them, so that each has sent a part before
either commits. Both require `writeIfAbsent` and cost `fast`. AWS documents that the first commit
to finish wins, and the multipart commit is the path on which an emulator was measured to let both
win.

`put/concurrent-writers` and the concurrent-writers promise of spec 4.11 stay as they are. They
were made for `put` without `onlyIf`, which still promises only that one of two writers wins; the
conditional form gets a sentence of its own beside it. Nothing is withdrawn, and ADR 0017 has no
conflict.

## The emulators

What SeaweedFS, Azurite and fake-gcs-server do with a precondition was measured
(`docs/research/emulator-preconditions.md` on `research/emulator-preconditions`). Where one drops
it, the case runs against the real endpoint alone (ADR 0012, ADR 0023, ADR 0034).

- fake-gcs-server ignores `ifGenerationMatch` on `rewriteTo` and on `DELETE` and overwrites or
  deletes: `copy/if-absent`, `copy/if-unchanged` and `delete/if-unchanged` are expected to fail
  there. It serves no `objects.move`, so `move/if-absent` and `move/if-unchanged` join
  `moveUnserved`. It checks a resumable upload's precondition at the commit, as GCS does, so the
  `put` cases need no entry.
- Azurite 3.37.0 has no `Put Blob From URL`: `copy/if-absent`, `copy/if-unchanged`,
  `move/if-absent` and `move/if-unchanged` join `copyUnimplemented`. Its `409 BlobAlreadyExists`
  for a key that is not free is what Azure answers, and no entry.
- SeaweedFS let two conditional `CompleteMultipartUpload` on a free key both succeed in 19 of 20
  rounds. An expected failure would pass in the twentieth round and fail the run, so
  `put/concurrent-if-absent-multipart` is unrun there, the reason naming the measured rate.
  SeaweedFS answers `If-Match` on a free key `412` where AWS answers `404`, and `adapter-s3` reads
  both as `PreconditionFailed`, so that needs no entry.

## Presigned uploads

The suite names no provider's headers, and a URL that binds "absent" on `adapter-azure-blob`
returns none (ADR 0074). The cases assert what the holder of a URL can observe.

- `presign/put-if-absent` requires `presignedUrls` and `writeIfAbsent` and costs `fast`. A URL
  signed with `onlyIf: "absent"` for a free key uploads with `2xx` and `stat` reports the object; a
  second one signed so for the key that now holds it answers `4xx`, and the object holds what it
  held.
- `presign/put-if-unchanged` requires `presignedUrls` and `writeIfUnchanged` and costs `fast`. A
  URL signed with the current `etag` uploads with `2xx`; one signed with that `etag` after another
  `put` replaced the object answers `4xx`, and the object holds the other `put`'s bytes.
- `presign/put-rejects-precondition` requires `presignedUrls`, `writeIfAbsent` and
  `writeIfUnchanged` and costs `slow`, as `presign/put-rejects-type` does. For each kind, the
  headers a URL signed with `onlyIf` returns beyond those of a URL signed without it are the
  binding; an upload leaving one of them out and one sending it with another value each answer
  `4xx` and write nothing. Where the binding holds no header, as "absent" on Azure, there is
  nothing to leave out, and `presign/put-if-absent` shows the binding.

Without `presignedUrls` the methods are absent, as in every presign case. With it and without the
other capability, `presignPut` carrying `onlyIf` rejects with `Unsupported` naming that capability,
`attempts: 0`, and returns no URL. On Azurite, `presign/put-if-unchanged` and
`presign/put-rejects-precondition` join `signedHeadersUnbound`, since `if-match` reaches `srh`.
Whether Azurite holds `sp=c` was not measured; a run that finds it does not adds its entry then.

## Spec 18 and CORS

The scheduled run on `main` runs the presign cases against the account under an access token, so
it observes a user delegation SAS with `sp=c` admitting an upload onto a free key and refusing one
onto an existing blob, and one naming `if-match` in `srh` admitting the signed `etag` and refusing
another, a missing one and a changed blob, each as `4xx`. The statuses ADR 0074 names, `403` for
`sp=c` and `412` for a changed blob, are a test of `adapter-azure-blob` against the account in the
`slow` tier, as ADR 0064 has for a differing `x-ms-blob-content-type`. Both points stay in spec 18
until the first scheduled run on `main` passes them.

Whether AWS and R2 admit a preflight naming `if-none-match` or `if-match` stays in spec 18 for
v0.7. Observing it would take CORS rules on both buckets, which is provisioning and no case. The
CORS rules of the conformance account and bucket (ADR 0023, ADR 0034) gain nothing: no preflight
test sends `if-match` or `x-goog-if-generation-match`, and
`docs/research/presigned-preconditions.md` already observed that both need an entry and that a
refusal carries `Access-Control-Allow-Origin`.

## Uploads over HTTP

The routes of spec 14.8 stay as they are. `upload/stores`, `upload/overwrites` and every other
existing case send no precondition and keep asserting `201`. Six cases join them, each `fast`:

- `upload/if-none-match` requires `writeIfAbsent`. `If-None-Match: *` onto a free key answers
  `201` with `ETag`; the same onto the key that now holds the object answers `412` with an empty
  body, and the object holds what it held. Without: `501`, and the key stays free.
- `upload/if-match` requires `writeIfUnchanged`. The `ETag` of a first upload answers `204` with
  the `ETag` of a later `stat` and replaces the bytes; that `ETag`, now stale, answers `412`; the
  current `ETag` as `W/` answers `412`; `If-Match` onto a free key answers `412`, and the key stays
  free. Without: `501`, and the object holds what it held.
- `upload/both-preconditions` requires `writeIfAbsent` and `writeIfUnchanged`. A current `If-Match`
  beside `If-None-Match: *` answers `412`, and the object holds what it held. Without: `501`.
- `upload/inexpressible-precondition` requires nothing. `If-Match: *`, `If-Match` with two tags,
  `If-None-Match` with a tag and `If-Unmodified-Since` alone each answer `501`, and the object
  holds what it held.
- `upload/malformed-precondition` requires nothing. `If-Match: abc` and `If-None-Match: "a` each
  answer `400`, which comes before `501` on every storage, and the object holds what it held.
- `upload/ignored-preconditions` requires nothing. `If-Modified-Since` in the past and in the future
  and `If-Range` each answer `201`, and the body is stored.

An `onlyIf` the caller passes to `acceptUpload` or `presignUpload` needs a route configured with
it, a new value of `answer` or a new duty of the `presign` route, which spec 15 counts as a new
required member of `HttpConformanceTarget`; ADR 0064 refused that for `storedCacheControl`. It is
option handling that does not depend on the runtime, so `@stowage/http` tests it on its own: how
the option holds together with the request's fields, a contradiction answered `412` without `put`,
`400` for an option of the wrong form, `412` from `presignUpload` for an `etag` that
`adapter-gcs` refuses, and `storageErrorOf` on the `412` of a `PreconditionFailed`, which a client
over HTTP cannot see. That the `400`, `501` and `412` come before the body is read is tested there
too, on a web `Request`: a client that keeps writing may meet a reset rather than the status
(ADR 0056).

Neither `ConformanceTarget` nor `HttpConformanceTarget` gains a member. The other writer a case
needs for a stale `etag` is the case's own second `put`.

## The reference flows

`flow/1-large-upload` and `flow/2-presigned-put` stay as they are. The precondition ADR 0074 and
ADR 0075 give flows 1 and 2 is optional, and `put/if-absent-multipart`, `presign/put-if-absent`
and `presign/put-if-unchanged` assert it on the paths those flows take.

## Release

Every case is new, and no existing case asserts more or less than in v0.6. A third-party adapter
or server that does not know `onlyIf` fails the new cases, which ADR 0006 and ADR 0070 price at a
minor. The changeset of `@stowage/conformance` is a minor without `**Breaking:**`. The divergence
entries are private and reach no changeset.

## Consequences

- Spec 14.5 gains, under `put`: `put/if-absent`, `put/if-absent-multipart`, `put/if-unchanged`,
  `put/if-unchanged-multipart`, `put/only-if-no-kind`, `put/concurrent-if-absent` and
  `put/concurrent-if-absent-multipart`; under `stat` and `exists`: `stat/etag-promised`; under
  `delete`: `delete/if-unchanged` and `delete/options`; under `copy` and `move`: `copy/if-absent`,
  `copy/if-unchanged`, `move/if-absent` and `move/if-unchanged`; under presigned URLs:
  `presign/put-if-absent` and `presign/put-if-unchanged` (`fast`) and
  `presign/put-rejects-precondition` (`slow`). `put/concurrent-writers` is unchanged.
- Spec 14.9 gains under uploading `upload/if-none-match`, `upload/if-match`,
  `upload/both-preconditions`, `upload/inexpressible-precondition`,
  `upload/malformed-precondition` and `upload/ignored-preconditions`. No existing case changes.
- Spec 4.3 states that the form of `onlyIf` decides the capability it needs, and that a value of
  neither form is `InvalidOption` on every storage. Spec 4.11 keeps its concurrent-writers promise
  for `put` without `onlyIf` and gains one for `onlyIf: "absent"`: of two such writers, at most one
  succeeds.
- Spec 14.4 gains, as tests of this repository:
  - the rule of ADR 0073 per cloud adapter against a stubbed `fetch`, with `PreconditionFailed` and
    `NoSuchUpload` after a `5xx` on a conditional `CompleteMultipartUpload`, and the cleanup of a
    GCS session meeting `412` on its cancel;
  - `adapter-s3` aborting an upload whose commit its precondition refused;
  - the `<Key>` of a `NoSuchKey` on a conditional `CopyObject`, against a stubbed `fetch`;
  - `adapter-gcs` refusing an `etag` that is no generation, `0`, `01` and 2⁶³ among them, without
    a request on `put` and on `presignPut`;
  - on `adapter-fs`: a conditional `move` of a key that holds a symbolic link, `EEXIST` on a
    directory and on a link that resolves to nothing as `InvalidRequest`, and a file system without
    hard links as `ProviderError` through a stubbed `link`;
  - the statuses of `sp=c` and of `if-match` in `srh` under a user delegation SAS, against the
    account in the `slow` tier.
- Spec 14.8 gains the tests of `@stowage/http` named above.
- Spec 18 keeps the three points of ADR 0074. The two on Azure leave it once the scheduled run on
  `main` passes the presign cases against the account; the one on CORS on AWS and R2 stays for
  v0.7.
- The divergence lists gain: on fake-gcs-server, `copy/if-absent`, `copy/if-unchanged` and
  `delete/if-unchanged` as expected failures, and `move/if-absent` and `move/if-unchanged` under
  `moveUnserved`; on Azurite, the four copy and move cases under `copyUnimplemented`, and
  `presign/put-if-unchanged` and `presign/put-rejects-precondition` under `signedHeadersUnbound`;
  on SeaweedFS, `put/concurrent-if-absent-multipart` unrun.
- The CORS rules of the conformance account and bucket are unchanged.
- The changeset of `@stowage/conformance` is a minor without `**Breaking:**`.
- Settled while writing the v0.7 spec (#447): fake-gcs-server 1.56.1 ignores
  `x-goog-if-generation-match` on a signed `PUT`, `0` and a stale generation alike, and overwrites,
  measured against a local instance on 2026-10-11. `presign/put-if-absent`,
  `presign/put-if-unchanged` and `presign/put-rejects-precondition` join its divergence list as
  expected failures, settled by `gcs`; the last one fails there in any case, since the emulator
  checks no signature.
