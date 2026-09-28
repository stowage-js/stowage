# The GCS adapter reads a failure from its JSON document whatever the label, and trusts a `404` only with `notFound`

Spec 4.10 has an adapter map a recognized provider code first and the status where none is
recognized, and fill `providerCode`, `requestId` and the provider's message from the answer.
Sections 7.9 and 8.8 do that for S3 and Azure, whose every failure carries its code in an XML
document or in `x-ms-error-code`. The JSON API that ADR 0031 chose does not: a JSON failure carries
`error.errors[].reason`, a media download answers in one line of text, and the service's frontend
answers `502` and `504` with a page of its own. ADR 0032 and ADR 0033 settled the refused names, the
batch `404`, the missing bucket on `delete`, the refused token and `403`; ADR 0036 and ADR 0037 met
`499`, `410` and the `404` of a continued rewrite. This settles the rest, and is the code table of
the adapter's section in the spec. The points the reference left open were measured against the
measurement bucket on 2026-09-28 on Node, on branch `spike/gcs-json-errors`.

A failure body is parsed as JSON first, whatever its `Content-Type`. The label cannot be trusted:
a refused `uploadType=multipart` upload is labelled `text/html` and carries the JSON document, and
every media failure is labelled `text/html` and carries one line of text without markup, such as
"No such object: <bucket>/<key>", "Request range not satisfiable" or "Invalid Credentials", with
`'` escaped as `&#39;`. Where the JSON holds `error`, `errors[0].reason` is `providerCode` and
decides through the table, and `error.message` is the message word for word. A body that is no
JSON and does not start with `<` is the message, with character references decoded. A body that
starts with `<` is not read, since it is a page of the frontend or, at a path the JSON API does not
serve, an XML `AccessDenied`; the message then names the status. Where no reason arrived,
`providerCode` stays unset and the status decides. Setting a code the adapter derived, such as
`notFound` for a media `404`, was the alternative, and it would put stowage's string where spec
4.10 promises the provider's own.

| Reason                                               | Error code           | Note                                                                              |
| ---------------------------------------------------- | -------------------- | --------------------------------------------------------------------------------- |
| `notFound`                                           | `NotFound`           | A missing bucket by its message, without `key`                                    |
| `forbidden`, `insufficientPermissions`               | `AccessDenied`       | ADR 0033                                                                          |
| `objectUnderActiveHold`, `retentionPolicyNotMet`     | `ProviderError`      | A state of the object stowage does not create                                     |
| `authError`, `required`                              | `InvalidCredentials` | After the one repeat of ADR 0033 where `WWW-Authenticate` carries `invalid_token` |
| `invalidArgument`, `requestedRangeNotSatisfiable`    | `InvalidRequest`     |                                                                                   |
| `uploadTooLarge`                                     | `InvalidRequest`     | Above the 5 TiB an object holds; `copyTo` is not sent (ADR 0037)                  |
| `invalid`                                            | `ProviderError`      | `InvalidOption` naming `cursor` when answered to a `list` that carried a cursor   |
| `conditionNotMet`, `conflict`, `clientClosedRequest` | `ProviderError`      | By status; stowage sends no precondition, and `499` ends a session (ADR 0036)     |

`retryable` follows the status alone, as ADR 0013 has it: no reason adds to the group of `408`,
`429` and every `5xx`, and none removes from it. The `503` in plain text that a chunk leaving a gap
meets stays in the group, although repeating it fails the same way, because the adapter never
sends such a chunk and an exception would be code for an answer it cannot meet.

The holds and retention reasons arrive with `403` and are not `AccessDenied`. ADR 0033 made `403`
`AccessDenied` because the principal is authenticated and may not do this; that names the role.
An object under a hold or a retention policy refuses a principal whose role allows the operation,
and a caller who answers `AccessDenied` by widening the role looks in the wrong place. Section 8.8
reads Azure's `BlobImmutableDueToPolicy` as `ProviderError` for the same reason. The map puts holds
and retention outside the promise, so no case of the suite meets either.

On the JSON paths — the resource, the listing, `DELETE`, a batch subresponse, `rewriteTo` and
`moveTo` — a `404` means absence only with the reason `notFound`. Any other `404` is
`ProviderError`, `retryable: false`, whose message says that the endpoint serves no such path.
Measured, a path the JSON API does not serve answers `404` in `text/html` with "Not Found" and no
reason, and a status rule would read that as absence: an `endpoint` with a wrong path prefix would
answer every `get` with `NotFound`, `exists` with `false`, and `delete` with every key deleted,
without a sign. This narrows ADR 0032, whose "a `404` for one key counts as deleted" now reads "a
`404 notFound`". fake-gcs-server carries `notFound` on every JSON `404`, so the per-commit run of ADR
0034 keeps reading absence where it did. A session URI whose session is gone answers `404` in
`text/plain` with "Not Found", which the same rule makes `ProviderError`: the bytes the session held
are lost. The media download keeps ADR 0034's rule and is read by its status alone, since it never
carries a reason, on the service or the emulator.

A missing bucket is told by its message on every path. Measured, the resource, the media download,
`DELETE`, `rewriteTo`, `moveTo` and the listing all answer `404` with "The specified bucket does not
exist.", the four JSON ones with reason `notFound`. It is `NotFound` without `key`, as ADR 0037 has
it for copies. `exists` rethrows it rather than answering `false`, which departs from spec 4.10,
where `exists` answers `false` for `NotFound` alone: a wrong bucket name is a configuration error,
and an `exists` that reads it as an absent object hides it behind an answer that looks right.
`adapter-s3` cannot follow, since its `HEAD` carries no code, and `adapter-azure-blob` could and
answers `false` for `ContainerNotFound` today; aligning it is outside this map, so the spec states
the rule per adapter and nothing changes for the other two. A key above 1024 bytes, which the addressable rule of spec 4.8 lets through,
answers `404 notFound` on the JSON API and is `NotFound`, and a key `delete` counts as deleted,
where sections 7.9 and 8.8 read their provider's `400` as `InvalidKey`. ADR 0032 reads the names
GCS cannot hold the same way, for the same reason: the answer is true.

`get` sends the resource and the media download side by side (ADR 0032). Where the resource fails,
its failure is reported, since it carries the reason and the message that tell a bucket from an
object. A failure of the media download is reported only where the resource succeeded. Either
failure aborts the other request, and a media failure arriving first waits for the resource's
answer, bounded by that request's own budget. `attempts` is the count of the request whose failure
is reported. Where one request fails and the other succeeds, because a writer created or deleted
the object between them, the failure is reported and nothing is repeated: a `get` racing a create
or a delete may answer `NotFound`. The repeat of ADR 0032 stays for the one race it covers, two
generations under one key. Reporting whichever failure arrived first was the other way, and it
would make `providerCode` and the bucket's message depend on timing.

A media `416` is reported as the core's `rangeStartRefusal` for the `size` the resource named:
`InvalidRequest` with the message every adapter gives, `status: 416`, no `providerCode`. Measured,
GCS answers `416` for a start at or past the end and for any range on an empty object, and clips
an end past the size to `206`, which is what spec 4.3 promises. Passing on "Request range not
satisfiable" was the alternative; where stowage knows the reason itself, the message should not
depend on the provider.

A `400` answered to a `list` that carried a cursor is `InvalidOption` naming `cursor`, as section
7.9 has it for `InvalidArgument` on S3. Measured, a forged `pageToken` answers `400 invalid` "Next
page token not valid". The cursor carries a tag of the adapter's own, `stowage-gcs-1:`, as
`adapter-s3` and `adapter-azure-blob` do, so a cursor of another storage is refused before any
request. A `400` to a `list` without a cursor stays `ProviderError`: the core bounds `pageSize`, and
`maxResults=-1` or `abc` never leave the adapter. A real token handed to a listing of another
prefix answers `200` with an empty page. The adapter does not detect that, and neither does any
other adapter.

`requestId` is `x-guploader-uploadid`, which Google calls the identifier to give its support and
which every answer carries, failures included, on every path measured. A batch's subresponses carry
none, so a key's entry in `failed` takes the outer answer's. On the requests of a resumable session
— its start, its chunks, its commit and its `DELETE` — `requestId` stays unset. Measured, there the
header holds the session's `upload_id`, the value that authorizes the session URI for a week, and
ADR 0036 keeps that URI inside the adapter. Leaving `requestId` unset everywhere was the other way,
and it would give up the one value support asks for on the requests that carry no secret.

ADR 0013's repeat holds on GCS unchanged. Google calls an insert, a copy and a delete without
`ifGenerationMatch` "conditionally idempotent". A repeated `DELETE` whose first answer was lost
meets `404 notFound` and counts as deleted. A repeated `rewriteTo` and every request of a session
are safe, as ADR 0036 and ADR 0037 measured, and `objects.move` has its rule in ADR 0037. What is
left is an upload repeated after a lost answer, which can replace a newer object another writer
stored in between. That is the case of two writers to one key, which spec 4.11 allows and ADR 0013
accepts on S3; `ifGenerationMatch` would need a generation the caller does not hand over.

## Consequences

- The GCS section of the spec carries the table above, the body rule, the `404` rule, the missing
  bucket, `get`'s two requests and `requestId`. `status` is set on every error that carries a
  response, `providerCode` where a reason arrived, the message where a body carries one.
- Spec 4.10 states per adapter what `exists` does with a missing bucket: `adapter-gcs` rethrows
  `NotFound` without `key`. `adapter-s3` and `adapter-azure-blob` do not change.
- ADR 0032 is narrowed: a key `delete` counts as deleted is one answered `404 notFound`. ADR 0033's
  `403` is `AccessDenied` except for the holds and retention reasons.
- A key above 1024 bytes is `NotFound` on GCS and `InvalidKey` on S3 and Azure. No conformance case
  asserts either, since spec 4.8 lets the key through and each provider answers it its own way.
- The session's `upload_id` never reaches a `StorageError`, in `requestId` or elsewhere.
- The body rule, the `404` without a reason, the missing bucket on `get`, `stat`, `exists`, `list`,
  `copy` and `move`, `get` with one of its two requests failed, the media `416`, the forged cursor
  and `requestId` on a session are tests of the adapter against a stubbed `fetch`, answering with
  the bodies and headers the spike recorded. The missing bucket on `exists` also runs against the
  real bucket, as ADR 0032's test of `delete` does.
- storage-testbench is not used for retries either. The loop is the core's `withRetry`, tested
  there, and what GCS adds to it is the answers above. That settles the last point ADR 0034 left
  open about it.
- The README of the GCS adapter names as a limit that a cursor handed to a listing of another
  prefix yields an empty page.
