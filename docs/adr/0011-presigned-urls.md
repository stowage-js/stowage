# Presigned URLs are reusable bearer tokens bound to one operation, key, and signed request values; v0.1 signs only `GET` and `PUT`

`@stowage/adapter-s3` exposes `presignGet` and `presignPut` on `S3Storage`, and nothing else that a
client without a credential can call. A POST policy — the base64-encoded document a browser posts as
`multipart/form-data` — is not part of v0.1.

Cloudflare states that R2 does not accept one: "`POST` (multipart form uploads via HTML forms) is
not currently supported", on the R2 presigned URL page as of 2026-08-22. `POST Object` appears in
neither of the two tables on the R2 compatibility page, which lists implemented and unimplemented
operations side by side. ADR 0003 promises AWS S3 and R2 alike through one adapter, so a
`presignPost` on `S3Storage` would be a method that works against one promised provider and answers
`403` against the other. ADR 0009 turned chunked signing down for that same reason, and the rule it
set there decides this: an option only AWS honors splits the parity core rather than raising it.

Three conditions are lost with it, and each is a condition a signed header cannot express.
`content-length-range` caps the size as a range, while a signed `content-length` fixes one number.
`["starts-with", "$key", "uploads/tenant-1/"]` lets the client name the object below a prefix, while
a presigned `PUT` has the key in the URL it signed. `["starts-with", "$Content-Type", "image/"]`
admits a family of types, while a signed `content-type` admits one. A POST policy also uploads from
a plain HTML form with no JavaScript, and it is a second signing path to build for that: its
StringToSign is the policy document itself, with no canonical request and no payload hash.

Binding through signed headers is exact because of how the signature is verified. The provider
rebuilds the canonical request from the values actually sent under the names in
`X-Amz-SignedHeaders`, and SigV4 signs each header value; `UNSIGNED-PAYLOAD` excludes the body
bytes from that signature. Changing a signed header therefore makes signature verification fail.
If the body length does not match the signed `Content-Length`, that is separate HTTP body-framing
validation rather than a signature mismatch. A browser can meet both bindings: `Content-Length` is
a forbidden request header, which means the user agent sets it from the body's length and the page
cannot forge it, and `Content-Type` is a header the page may set. The limit is that a body of
unknown length carries no `Content-Length` at all, so a stream cannot be uploaded through a
presigned `PUT`.

Presigning is the one capability that adds a method rather than changing a behavior, which is why
its conformance case cannot assert what most of them assert without the capability: that the call
fails with `Unsupported`. The closed core of ADR 0004 keeps `presignGet` and `presignPut` off
`Storage` entirely, so on `adapter-fs` and `adapter-memory` there is no call to fail. The case
checks that the method is absent instead, which is the same assertion at the level the type system
already makes it, and `presignedUrls` stays in the runtime declaration of ADR 0015 so that there is
something to check it against.

## Consequences

- `presignPut` requires `expiresIn`, `contentType` and `contentLength`. An optional binding would
  hand out a URL that writes any number of bytes of any type without the caller having decided that,
  which is the hole a POST policy would be asked to close.
- The TSDoc on `presignPut` says the length binds exactly. A caller who knows only an upper bound
  cannot express it, and there is no option that relaxes the binding to a range.
- Reference flow 2 therefore costs one round trip before the signature: the client reports the size,
  the server checks it against its own limit and signs that number. The server cannot verify the
  reported size, only refuse to sign an implausible one.
- `expiresIn` is required and checked against 1 to 604800 seconds, the ceiling SigV4 query signing
  sets. Outside it the adapter throws `InvalidOption` naming the ceiling, rather than producing a
  URL the provider rejects. The credential lowers the ceiling further, as ADR 0007 records.
- There is no option to sign a checksum header into the URL. ADR 0009 keeps `x-amz-checksum-*` out
  of the adapter, and a presigned `PUT` signs `UNSIGNED-PAYLOAD`, so flow 2 carries no integrity
  check. This is a property of the flow stated in the spec, not a switch the caller can flip.
- A presigned `PUT` binds no user metadata. Every bound header is a header the browser has to match
  exactly, and a mismatch produces a `403` that names nothing. Metadata is written server-side after
  the upload.
- There is no presigned multipart upload. Signed URLs per part are a protocol across several of
  them, with an upload id to carry and abandoned uploads to clean up from a browser, and no
  reference flow asks for it.
- `presignGet` takes `responseContentType`, `responseContentDisposition`, `responseCacheControl` and
  `responseExpires` together, on `S3Storage` rather than on the portable type. S3 answers all four
  as query parameters, and carrying three of them is a line nobody can explain. R2 documents
  neither support nor refusal, which is why ADR 0014 leaves the four provisional until the first
  run against a real R2 bucket. The successful `GetObject` case makes one positive assertion per
  override: `responseContentType` equals the returned `Content-Type`, `responseContentDisposition`
  equals `Content-Disposition`, `responseCacheControl` equals `Cache-Control`, and
  `responseExpires` equals `Expires`.
- The four override assertions are a test of `adapter-s3` in this repository's `slow` tier rather
  than a case of `@stowage/conformance`. The options exist on `S3Storage` alone, and a suite case
  runs against `Storage`, where passing them would be the `InvalidOption` of ADR 0005 on any other
  adapter that declares `presignedUrls`.
- The provider answers the browser, so the adapter never sees the rejection and the error codes of
  ADR 0005 do not reach it. `@stowage/core` exports no function that turns a foreign `Response` into
  a `StorageError`: it would be a second public way into the error mapping, for a request the
  adapter neither made nor configured.
- The conformance suite carries the rejections as cases in the expensive tier under `presignedUrls`:
  a deviating content type, a deviating length, and an expired URL, each checked on the status and
  the provider code of the raw response, read from a runtime rather than from a browser. They are
  what flow 2 promises, and an adapter that declares `presignedUrls` could otherwise claim them
  without delivering them. What reaches the browser can be less: R2 sends no CORS headers on the
  `403` for an expired URL, so page JavaScript sees a network error where the status itself names
  the cause.
- Flow 2 names two bucket preconditions rather than assuming them: the bucket policy must allow
  `UNSIGNED-PAYLOAD` (ADR 0009), and the bucket needs a CORS configuration, because a signed content
  type outside the CORS safelist makes the upload a preflighted cross-origin request. Bucket
  management is not in v0.1, so stowage can state both and configure neither.
- POST policies become worth building once R2 implements `POST Object`. Until then they are an
  AWS-only capability, and the size of the thing is not what stands in the way: `s3-lite-client`
  signs one in about 130 lines and `@aws-sdk/s3-presigned-post` in about 149.
- AWS has removed the SigV4 chapter covering POST policies and query-string signing from the live S3
  API reference. Where this repository cites either, it cites an Internet Archive capture.
