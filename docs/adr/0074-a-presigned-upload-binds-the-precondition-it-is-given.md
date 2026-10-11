# A presigned upload binds the precondition it is given, as a permission on Azure where it is "absent"

ADR 0070 gave `put` and the destination of `copy` and `move` a precondition. Reference flow 2
uploads from a browser through `presignPut`, which binds the content type, the length and the
content headers given through signed headers (ADR 0011, ADR 0063), and `@stowage/http` hands the
URL out through `presignUpload` (ADR 0049). This records whether the two take a precondition, and
how each adapter binds one (#444), from what AWS S3, R2, GCS and Azure were measured to do with a
precondition in a presigned `PUT` (`docs/research/presigned-preconditions.md` on
`research/presigned-preconditions`, commit `ab48108`).

`presignPut` takes `onlyIf: "absent" | { etag: string }`, the option `put` takes, with its checks
and their order: a storage that does not declare the capability the value needs, `writeIfAbsent`
or `writeIfUnchanged`, refuses it as `Unsupported` naming that capability, and a value of the wrong
form is `InvalidOption` naming `onlyIf`. Both come before signing, before Azure's user delegation
key request, with `attempts: 0`. No capability is added: every adapter that declares
`presignedUrls` declares both (ADR 0071), and a separate one for the presigned form would draw a
line no provider showed. Every provider binds both kinds so that whoever holds the URL can neither
drop nor change them, each in its own form, and none answers a deviation with a write. Offering
"absent" alone was the alternative, since "unchanged" on Azure rests on a binding no real key has
signed; ADR 0063 met the same gap for the content headers by declaring the binding and putting the
point in spec section 18, and this does the same.

`adapter-s3` signs `If-None-Match: *` or `If-Match` with the `etag` as a signed header and returns
it in `PresignedPut.headers`. AWS and R2 answer the signed value failing with `412`, and a request
that sends none or another value with `403 SignatureDoesNotMatch` before the precondition is
looked at, so nothing is written. AWS also honors the precondition as a signed query parameter,
which would need no CORS entry, but no document states it and R2 ignores that form and overwrites,
so `adapter-s3`, blind to its provider (ADR 0014), cannot rest on it. A bucket policy with
`s3:if-none-match` binds a bucket rather than a URL and is not stowage's to set.

`adapter-gcs` signs `x-goog-if-generation-match`, `0` for "absent" and the generation for an
`etag`, and returns it in `headers`. GCS answers a missing one with `400 MalformedSecurityHeader`,
another value with `403 SignatureDoesNotMatch`, and refuses an unsigned one outright. The XML `PUT`
a signed URL addresses ignores `If-None-Match` and `If-Match` even when signed and overwrites, so
the generation is the only form, which ADR 0070 already made the `etag` of `adapter-gcs`. An `etag`
that is no generation is `PreconditionFailed` with `attempts: 0` and no URL, as `put` refuses it
without a request. `InvalidOption` would have the adapter promise the form of its `etag`, which
ADR 0070 rules out; signing it anyway would hand out a URL that can never upload.

`adapter-azure-blob` binds "absent" through the permission: the SAS carries `sp=c` (Create) in
place of `sp=w`, and neither `srh` nor `headers` changes. Azure refuses an upload onto an existing
blob under `sp=c` with `403 UnauthorizedBlobOverwrite` before it reads any conditional header, for
`Put Blob`, `Put Block` and `Put Block List` alike. There is no header to send, to drop or to allow
in the account's CORS rule. Naming `if-none-match` in `srh` and sending `If-None-Match: *` was the
alternative. It reads like the other adapters, but every flow-2 CORS rule on Azure would need
`if-none-match`, and a refusal would be `409 BlobAlreadyExists`, which a page can tell from a
deviating request where `sp=c`'s `403` cannot. Flow 2 promises no single status for a refusal
already, so the stronger binding with nothing to configure wins. "Unchanged" keeps `sp=w` and
appends `if-match` to `srh`, after the content headers of ADR 0063, with `If-Match` and the `etag`
in `headers`: `sp=c` refuses `If-Match` as `AuthorizationPermissionMismatch` even where it matches.
The name goes into `srh` in lower case, since Azure signs it as written there.

The provider checks the precondition when the upload arrives, not when the URL is signed: a URL
signed for a free key is refused once someone else wrote it first. A browser that repeats an upload
whose answer it lost meets its own object and is refused, as ADR 0073 has for a conditional request
an adapter repeats. The browser cannot tell the two apart; spec 4.10 names the open outcome and the
way out, a `stat` and a metadata value of the caller's own, which the server that signed the URL
can follow.

`presignUpload` takes `onlyIf` as an optional option and hands it to `presignPut`, and `PresignsPut`
names it as an optional member of the options it passes. It never reads it from a request, which
ADR 0049 rules out for every value: the caller hands over an `etag` the client sent in the body. A
value of the wrong form is `400` before signing, so a client's value never reaches `presignPut` as
an `InvalidOption` answered `500`, the reasoning of ADR 0063. A storage that does not declare the
capability refuses it in `presignPut`, answered `500`, since that is the caller's storage and not
the client's value. A `PreconditionFailed` from `adapter-gcs` becomes a status by section 10.2,
which "acceptUpload with preconditions" (#445) settles for the code.

Nothing narrows a promise, so ADR 0017 has no conflict: `onlyIf` on `presignPut`, on
`PresignsPut` and on `presignUpload` are additions, and a URL signed without it overwrites an
existing object as before.

## Consequences

- `S3PresignPutOptions`, `AzureBlobPresignPutOptions` and `GcsPresignPutOptions` gain `onlyIf`,
  which spec 7.10, 8.9 and 9.9 state with the form each adapter signs and what its provider answers.
  On `adapter-azure-blob` the table of section 8.9 shows `sp=c` for "absent" and `if-match` in `srh`
  for "unchanged".
- Spec 10.1 gives `PresignsPut` and `PresignUploadOptions` an optional `onlyIf`, and 10.6 the `400`
  for a value of the wrong form and the `500` for a storage without the capability.
- Spec flow 2 gains the precondition in "In"; in "Holds when" that a precondition given is bound so
  that the provider refuses an upload onto a key that holds an object, or onto an object that
  changed, and that the holder can neither drop nor change it; in "Fails as" a failed precondition,
  answered `412` on S3, R2 and GCS, `404` on AWS for "unchanged" against a key that holds no
  object, and on Azure `403` for "absent" and `412` for "unchanged", with no single status
  promised; the repeat after a lost answer; and in "Requires" `if-none-match` or `if-match` on
  `s3` and `x-goog-if-generation-match` on `gcs` where the URL binds one, and `if-match` on
  `azure-blob` for "unchanged" alone.
- Spec section 18 gains three points until the scheduled run on `main` observes them: a user
  delegation SAS with `sp=c` refusing an upload onto an existing blob with `403`, and admitting one
  onto a free key; a user delegation SAS naming `if-match` in `srh` admitting the signed `etag`,
  refusing a request without it or with another, and answering `412` on a blob that changed; and
  whether AWS and R2 admit a preflight naming `if-none-match` or `if-match` under a rule that
  allows them, and send `Access-Control-Allow-Origin` on the `412`.
- The changesets of `adapter-s3`, `adapter-azure-blob`, `adapter-gcs` and `http` are minors and
  carry no `**Breaking:**`.
- Which cases the suites gain for this decision, and whether the CORS rules of the conformance
  account and bucket (ADR 0023, ADR 0034) gain `if-match` and `x-goog-if-generation-match` for
  them, is decided under "Conformance and HTTP cases for preconditions" (#446).
