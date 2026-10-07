# A presigned upload binds the content headers it is given and leaves the others open

ADR 0058 gave `put` the three content headers. Reference flow 2 uploads from a browser through
`presignPut`, which binds `contentType` and `contentLength` through signed headers (ADR 0011,
ADR 0022), and `@stowage/http` hands the URL out through `presignUpload` (ADR 0049). This records
what the two take for `Cache-Control`, `Content-Disposition` and `Content-Language`, what an
option left out means, and a gap in the binding of the content type on Azure that the measurements
for it turned up (`docs/research/content-headers-presign.md` on `research/content-headers-presign`,
commits `2a555f9` and `010b090`).

`presignPut` takes `cacheControl`, `contentDisposition` and `contentLanguage` as optional options,
checked as `put` checks them: the header-value rule as `InvalidOption`, the 2,048 bytes together
with `Content-Type` and the 100 characters of `contentLanguage` as `InvalidRequest`, before
signing and before Azure's user delegation key request, with `attempts: 0`. The content type is
required on a presigned upload, so the bound always counts it. Each value given is signed into the
URL and returned in `PresignedPut.headers`, so the browser code of flow 2 still sends `headers` as
they come and never names the provider. `adapter-s3` and `adapter-gcs` sign the standard names;
AWS, R2 and GCS refuse a value that differs or is missing, and store the signed one as sent.
`adapter-azure-blob` signs the `x-ms-blob-*` forms in `srh`, because `Put Blob` stores no standard
`Content-Disposition` and lets an `x-ms-blob-*` header override the standard one. Making them
required, as `contentType` is, would have broken every caller of `presignPut` for headers most of
them do not set.

An option left out leaves its header open: whoever holds the URL may send it unsigned, and the
provider stores it, as every provider does today. Binding "no header" was refused. On AWS and R2 a
header signed empty is met by sending none, but GCS answers a missing signed header with
`400 MalformedSecurityHeader` and Azure refuses a request missing a name in `srh`, so on both the
browser would have to send three empty headers and every flow-2 CORS rule would have to allow
them, for callers who never use the options. Binding it on AWS and R2 alone would split the parity
core along a provider line. An open header is the reading ADR 0062 already gave a stored one: it
may be the client's word, and `serveObject` serves it only where that is harmless.

No capability is added. S3, R2 and GCS bind the three as measured, R2 under its write token for
this decision. Azure binds them under a user delegation SAS, the one form `presignPut` signs on
Azure already (ADR 0022): it reads the values of the `x-ms-blob-*` names in `srh` into its string
to sign and refuses a request missing one. No signature of a real key over them has been measured,
because `Get User Delegation Key` needs an Entra token this machine does not hold, so that point
joins spec section 18 until the scheduled run on `main` signs one.

The measurements also found that `srh` does not close the binding of the content type on Azure.
`Put Blob` stores an `x-ms-blob-content-type` in place of `Content-Type`, and under a service SAS
an unsigned one overrode the signed type. Whether a user delegation SAS admits a header `srh` does
not name is not measured; Azure's documentation names only what must be present. A browser cannot
send it while the CORS rule does not allow it, but a client outside a browser can store
`text/html` under a URL signed for `image/png`, and binding the type is what flow 2 is for. So the
SAS of `presignPut` names `x-ms-blob-content-type` in `srh` with the content type's value, and
`headers` carries it. The repair changes a precondition spec flow 2 states, the CORS rule on the
account, so a deployed rule refuses the preflight after an update. That narrows flow 2 on
`adapter-azure-blob`, conflicts with ADR 0017's patch for code that disagrees with the spec, and is
priced as a withdrawal in v0.6 instead. Measuring first was the alternative; it would have left a
known way around the one binding a caller relies on for safety until someone held a token.

SigV4 and GOOG4 collapse runs of spaces in a signed value before comparing, so a URL signed for
`public, max-age=60` admits `public,  max-age=60` and the provider stores the two spaces, measured
on AWS, R2 and GCS. The same canonicalization applies to `Content-Type`, so flow 2's "the binding
is exact" was never true of the value's whitespace. Flow 2 states the binding as exact up to runs
of spaces, which a measurement disproving a promise withdraws in a minor release under ADR 0017.
It lets a client reach no other type, disposition or language than the one signed.

## Consequences

- `S3PresignPutOptions`, `GcsPresignPutOptions` and `AzureBlobPresignPutOptions` gain the three
  optional options, which spec 7.10, 8.9 and 9.9 state. `presignedUrls` covers them.
- The SAS of `presignPut` on Azure carries
  `srh=content-type,content-length,x-ms-blob-type,x-ms-blob-content-type`, followed by
  `x-ms-blob-cache-control`, `x-ms-blob-content-disposition` and `x-ms-blob-content-language` for
  each option given, in that order. `headers` carries `content-type`, `x-ms-blob-type`,
  `x-ms-blob-content-type` and the `x-ms-blob-*` header of each option given. On `adapter-s3` and
  `adapter-gcs`, `headers` carries `content-type` and the standard name of each option given.
- Spec flow 2 states that a content header the URL does not bind can be set by whoever holds the
  URL and is stored, and that the binding is exact up to runs of spaces.
- Flow 2's CORS preconditions gain every header the URL binds: on `s3` and `gcs`
  `cache-control`, `content-disposition` and `content-language` where the options are used, on
  `azure-blob` `x-ms-blob-content-type` always and the `x-ms-blob-*` name of each option used.
  `Content-Language` is a CORS-safelisted header only up to 128 bytes of a restricted alphabet, so
  the rule names it rather than relying on that. A caller who passes none of the options changes
  nothing on S3, R2 and GCS.
- Two changes narrow what v0.5 promises and conflict with ADR 0017, so the changesets mark them
  `**Breaking:**`: on `adapter-azure-blob`, `headers` gains `x-ms-blob-content-type` and the
  account's CORS rule must allow it; on `adapter-s3`, `adapter-azure-blob` and `adapter-gcs`, the
  binding of the content type is exact up to runs of spaces. The three options are additions.
- Spec section 18 gains one promise of `adapter-azure-blob`: a user delegation SAS naming the
  `x-ms-blob-*` headers in `srh` admits an upload carrying the signed values and refuses one that
  differs or lacks one, `x-ms-blob-content-type` among them. Whether Azure collapses runs of spaces
  as SigV4 does is recorded there too. R2 needs no point; the upload was observed.
- `presignUpload` takes the three as optional options and `PresignsPut` names them as optional
  members of the options it passes. It never reads them from a request, which ADR 0049 already
  rules out for every value. A value that breaks the header-value rule or one of the bounds is
  `400` before signing, so a client's value a caller passes on never reaches `presignPut` as an
  `InvalidOption` answered `500`. The bounds answer `400` rather than `413`, which belongs to the
  body. Both functions share the rule with the core (ADR 0058).
- `acceptUpload` takes the three as optional options and hands them to `put`. It never takes them
  from the request's headers: a request's `Cache-Control` is a directive to the server, a request
  has no `Content-Disposition` of meaning, and user metadata is already kept from request headers
  for the same reason. A value the caller passes that `put` refuses is the caller's `InvalidOption`
  and answers `500`, as for `contentType`.
- The CORS rules of the conformance account and bucket (ADR 0023, ADR 0034) gain
  `x-ms-blob-content-type` on Azure, since the preflight test of the `slow` tier sends the
  headers `presignPut` returns. Whether they gain the content headers, and which cases the suites
  add for this decision, is decided under "Conformance and HTTP cases for the content headers"
  (#375).
- Settled under "Write the v0.6 spec" (#376): a storage that does not declare `contentHeaders`
  refuses the three in `presignPut`, which `presignUpload` answers `500`, since that is the
  caller's storage and not the client's value. A value `acceptUpload` hands to `put` that `put`
  refuses by a bound is `InvalidRequest` and answers `500` as well.
