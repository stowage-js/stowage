# `acceptUpload` holds the precondition of the request and of its caller

ADR 0070 gave `put` a precondition, `onlyIf: "absent" | { etag: string }`, and ADR 0074 let
`presignUpload` hand one to `presignPut` from options alone. `acceptUpload` streams a request body
into `put` (ADR 0049), and reads neither `If-Match` nor `If-None-Match` today: a client that sends
one has it dropped in silence, and the upload overwrites whatever the key holds. This records how
`acceptUpload` takes a precondition (#445).

`acceptUpload` takes it from both sides. `AcceptUploadOptions` gains `onlyIf`, the caller's policy,
such as a route that never overwrites, and the layer reads `If-Match` and `If-None-Match` of the
request, the client's wish. Every precondition given holds together: the layer passes `put` the one
`onlyIf` that satisfies all of them, and where none can, it answers `412` without calling `put`.
`"absent"` beside an `If-Match`, `{ etag: "a" }` beside `If-Match: "b"`, `{ etag }` beside
`If-None-Match: *`, and a request carrying both `If-Match` and `If-None-Match: *` are such cases.
Options alone, as on `presignUpload`, was the alternative. RFC 9110 13.1.1 has an origin server that
receives `If-Match` evaluate it, and a caller who forgets to hand the header over would drop it in
silence as today. The client's `If-Match` is the point here, unlike the content headers of
ADR 0063: it is the `ETag` `serveObject` and `acceptUpload` handed out. An option that replaces the
request's header was the other alternative; under `"absent"` it would write onto a free key for a
client that asked to write only over the object it read.

The layer reads the request's fields in the order of RFC 9110 13.2.2, and compares `If-Match`
strongly (RFC 9110 8.8.3.2).

- `If-None-Match: *` is `"absent"`.
- In `If-Match`, a weak tag never matches and is dropped, and so is a tag outside the form ADR 0070
  gives the `etag` in `onlyIf`, such as `""`, since no storage hands one over. One distinct tag left
  is `{ etag }`; none left is `412` without `put`.
- `If-Match` with two or more distinct tags left, and `If-Match: *`, hold together with a caller's
  `{ etag }` as that `etag` where they name it or are `*`, and are `412` where they do not.
  Without a caller's `{ etag }` they cannot be expressed as `onlyIf`, and neither can
  `If-None-Match` with tags rather than `*`, nor `If-Unmodified-Since` without `If-Match`. Holding
  them would take a `stat` in front of the write, which is the race a precondition exists to close,
  and dropping them would write where the client asked not to. They are `501`, as AWS answers
  `If-Match: *` (`docs/research/presigned-preconditions.md` on `research/presigned-preconditions`).
- `If-Modified-Since` applies to `GET` and `HEAD` alone (RFC 9110 13.1.3), and `If-Range` to a
  request with `Range` (RFC 9110 13.1.5), which an upload does not carry; both are ignored, as is
  `If-Unmodified-Since` beside `If-Match`.

A precondition the client sent for which the storage declares no capability, `writeIfAbsent` or
`writeIfUnchanged`, is `501` too, read from `storage.capabilities` before the body. Letting `put`
refuse it as `Unsupported` would answer `500` to a value the client chose, after the body had
perhaps been read. An `onlyIf` the caller passes on a storage without the capability stays with
`put` and is `500`, as on `presignUpload`: that is the caller's storage, not the client's value.

An `If-Match` or `If-None-Match` that is no list of entity tags is `400`. `serveObject` keeps
reading such a field as naming nothing, where a malformed `If-None-Match` lets a `GET` through and
costs a body; on a write it would overwrite what the client meant to protect. An `onlyIf` option of
the wrong form is `400` as well, as on `presignUpload`, since a caller may pass on an `etag` the
client sent in a query or a body (ADR 0074).

The checks follow RFC 9110 13.2.1, which ignores preconditions where the answer without them would
not have been a `2xx` or `412`: the `TypeError`s of section 10.5, then `405`, `415` and the
`Content-Length` checks, then a malformed field or option (`400`), a field the layer cannot hold
(`501`), preconditions that cannot hold together or an `If-Match` with no tag left (`412`), and only
then `put`. All of them come before the body is read, and like the layer's other refusals, the
`412` and `501` it answers itself carry no `StorageError`.

`PreconditionFailed` is `412` in section 10.2's table, with an empty body and the error behind it
for `storageErrorOf`. It carries no `ETag` of the object that holds the key, since reading one would
take a `stat`. The row serves `presignUpload` as well, where `adapter-gcs` refuses an `etag` that is
no generation (ADR 0074) and the client's value is what failed. A `PreconditionFailed` that
ADR 0073 reports as the earlier `NetworkError` or retryable `ProviderError` is `503` by the existing
table.

The layer sends no `stat` in front of `put`. Every path checks the precondition at its commit
(ADR 0073), so a client whose precondition fails has usually sent its whole body when the `412`
arrives; only a refusal without a request, as `adapter-gcs` gives an `etag` that is no generation,
comes before. A `stat` in front would save those bytes in the rare case of a refusal and cost a
request in the common case of a success, and the precondition on `put` would still be the one that
holds.

A stored object is `201` without a precondition and under `"absent"`, and `204` under `{ etag }`,
with the same `ETag` and `objectStatOf`. ADR 0049 answers `201` whether or not the key held an
object, since telling the two apart would take a `stat` that races the upload. A write under
`{ etag }` replaced an object for certain, and RFC 9110 9.3.4 answers a replacement `200` or `204`.

Two things stay outside. No option demands a precondition with `428 Precondition Required`
(RFC 6585 3): a caller checks the request's headers before the call, as for the content type
(ADR 0049), and the README shows it. No `DELETE` helper joins the layer: a caller builds the route
from `delete(key, { onlyIf })` and its `DeleteReport`, as it builds the listing endpoint of
ADR 0054.

Reading the request's fields narrows what `acceptUpload` promises, which conflicts with ADR 0017
and amends ADR 0049. A `PUT` with an outdated `If-Match` that is stored today is `412` after the
change, one with `If-Match` on `adapter-fs` or with `If-Match: *` alone is `501`, and one whose
`If-Match` holds is answered `204` where ADR 0049 promised `201`. The spec never promised to ignore
the fields, but a server whose clients send them is answered differently from before. The `http`
changeset starts with `**Breaking:**`. No option switches the fields off, since RFC 9110 has an
origin server evaluate them; a caller who means to drop them builds a `Request` without them before
the call.

## Consequences

- Spec 10.1 gives `AcceptUploadOptions` an optional `onlyIf`.
- Spec 10.2 maps `PreconditionFailed` to `412` for every function of the layer, and lists `501`
  among the layer's own refusals.
- Spec 10.5 states the two sources and how they hold together, the mapping of the request's fields,
  the `400`, `501` and `412` before the body and their order, `412` for `PreconditionFailed`, and
  `204` under `{ etag }`. Its sentence on a client still sending a refused body names `412` and
  `501` beside `405`, `413`, `415` and `400`. `serveObject` in 10.3 is unchanged.
- ADR 0049 points at this one for the `201` it no longer sends under `{ etag }`.
- Flow 1 gains an optional precondition in "In", `PreconditionFailed` in "Fails as", and in
  "Through a route" that `acceptUpload` evaluates `If-Match` and `If-None-Match` together with
  `onlyIf`.
- The README of `@stowage/http` shows the `428` check before the call, and the `Request` without
  the fields for a caller who drops them.
- The `http` changeset starts with `**Breaking:**`.
- Which HTTP cases cover the mapping, the `400`, `501` and `412` before the body, `412` for
  `PreconditionFailed` and `204` under `{ etag }` is decided in #446.
- The README of `@stowage/http` also tells a cross-origin route to allow `if-match` and
  `if-none-match` in its preflight answer and to name `ETag` in `Access-Control-Expose-Headers`,
  since a page that cannot read the `ETag` cannot send it back (settled while writing the v0.7
  spec, #447).
