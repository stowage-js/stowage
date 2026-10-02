# The HTTP layer serves an object by streaming or by redirect, the caller's choice, and promises RFC 9110 for one range

`@stowage/http` (ADR 0046) answers a request for a stored object in two ways, each a function of
its own: `serveObject` streams the body through the server from `get` and `stat`, and
`redirectToObject` answers `302` to a `presignGet` URL. The caller picks by calling one or the
other; the layer never chooses. A redirect hands ranges, preconditions and a content coding to the
provider, which answers them correctly, and serves user content from the provider's origin instead
of the application's (`research/http-serving-semantics`, commit `03643f2`). Streaming is the only
way for `adapter-memory` and `adapter-fs`, and for a caller who wants the bytes to pass through its
own server. Leaving the redirect to the caller would have left them to build the
`Content-Disposition` override and the `Cache-Control` of the `302` themselves; one function with
a switch would have taken a storage that cannot presign and failed only at run time.

A `StorageError` becomes a status by what it says about the request, not by the provider's status.
`AccessDenied`, `InvalidCredentials` and `Expired` describe the server's credential, not the
client's rights, which the caller checks before calling, so they are `500` like every other
misconfiguration and not `403`. `InvalidKey` is `404`: no object can live under such a key, and a
`400` would tell the client the key rules. A transient failure is `503`. The body carries nothing of
the error: a provider's message names buckets and accounts. ADR 0046 rules out a hook, so the
caller reaches the error through `storageErrorOf(response)`, a lookup on the very `Response` object
the layer returned.

`get` cannot express everything `Range` and the conditional headers ask for, and every server
surveyed departs from RFC 9110 somewhere. `serveObject` honors one range, a suffix range included,
and every precondition in the order and with the comparison RFC 9110 13.2.2 sets, and ignores what
HTTP lets a server ignore: several ranges, a foreign unit, a malformed header, a `Range` on a
storage without `rangeReads`. To answer them it calls `stat` first only where the request carries a
precondition or a suffix range, and decides by the `stat` that `get` resolves with, since that one
describes the bytes being sent. Calling `get` first always would have started a download for every
browser revalidation that ends in `304`; calling `stat` first always would have made every download
cost two requests.

The layer cannot tell a content-coded object apart: `ObjectStat` carries no coding, and the refusal
of a range on one is a plain `ProviderError` (ADR 0044). With `Content-Length: size` on a whole
object, Node and Deno cut a decoded body to its stored length and end the response as complete, so
`serveObject` sends no `Content-Length` on a `200` or a `HEAD`. A client sees no total and no
progress, which Bun and `workerd` already impose on any streamed body. A `206` carries one, since a
ranged `get` never hands such an object over.

## Consequences

- `serveObject(storage, key, request, options?)` takes the portable `Storage`, with `filename`,
  `disposition` (`"attachment"` or `"inline"`) and `cacheControl`.
  `redirectToObject(storage, key, request, options)` takes a structural `PresignsGet`, naming
  `presignGet` with `expiresIn` and `responseContentDisposition`, the options `adapter-s3`,
  `adapter-azure-blob` and `adapter-gcs` share. `expiresIn` is required and has no default, as on
  `presignGet`. `PresignsGet` and the type for presigned uploads are separate, so a storage needs
  only the one it is used for.
- Status by code: `NotFound` with `key` and `InvalidKey` are `404`; `InvalidRequest` from a ranged
  `get` is `416`; `NetworkError` and a `retryable` `ProviderError` are `503` without `Retry-After`;
  everything else, `NotFound` without `key` among it, is `500`. The body is empty.
  `storageErrorOf` answers `undefined` for a `Response` the layer did not produce from an error, and
  for a copy of one.
- Ranges: a satisfiable range is `206` with `Content-Range` and `Content-Length`; an unsatisfiable
  one is `416` with `Content-Range: bytes */<size>`, its size taken from a `stat` after the failed
  `get`. `Accept-Ranges: bytes` is sent where the storage declares `rangeReads`. A ranged `get` that
  rejects with a non-retryable `ProviderError` is followed by one whole `get`, answered `200`: that
  is the content-coded object of ADR 0044, which only its message would tell apart, and a genuine
  provider failure fails the second `get` alike. No `multipart/byteranges`.
- Preconditions: `If-Match` and `If-Range` compare strongly, `If-None-Match` weakly; dates are
  compared at whole seconds, and a `lastModified` later than the response's `Date` is replaced by
  it. The layer sets that `Date` itself, since Bun and Deno write one of their own up to a second
  behind their clock, which a `Last-Modified` capped at the clock could lie after. A storage that hands over no `etag`, `adapter-fs`, gets no `ETag` and none derived for it:
  revalidation works through `Last-Modified`, and `If-Match` fails. `If-Range` with a date never
  holds, since a date at second resolution is no strong validator, and the whole object is sent.
  The provider's `etag` is sent quoted as a strong tag.
- With `stat` first, the object counts as changed when the `etag`s differ, or, without one, `size`
  or `lastModified`. Then the preconditions are evaluated again against the `stat` of `get`; where
  the outcome changes, the body is canceled and the new outcome answered, at most with one more
  whole `get`.
- `HEAD` is answered from `stat` with the headers of the `GET`, no body, no `Content-Length` and
  `Range` ignored. The layer reads `request.method` itself, because Hono and Next.js route `HEAD` to
  the `GET` handler. Any other method is `405` with `Allow: GET, HEAD`.
- `redirectToObject` answers `HEAD` with the same `302`. A URL from `presignGet` is signed for `GET`
  on S3 and GCS, so the followed `HEAD` fails there with `403`; the README states it, and points a
  caller who needs `HEAD` to `serveObject`.
- Headers of `serveObject`: `Content-Type` as stored; `X-Content-Type-Options: nosniff` always;
  `Content-Disposition` `attachment; filename="<ASCII fallback>"; filename*=UTF-8''<pct-encoded>`
  by default, the name being `filename` or the key's last segment, and `attachment` alone where the
  key ends in `/`; `Cache-Control: private, no-cache` unless `cacheControl` says otherwise. The
  `302` carries `Cache-Control: private, no-store`, because its URL expires, and the same
  disposition through `responseContentDisposition`.
- `inline` is the caller's explicit choice and the caller's risk: an uploaded `text/html` or
  `image/svg+xml` served inline from the application's origin runs with its rights, which `nosniff`
  does not prevent. The layer adds no `Content-Security-Policy: sandbox`, since Chrome then refuses
  to show a PDF inline, the most common reason to choose `inline`.
- Every other header is the caller's to set on `response.headers` afterwards. The layer builds every
  `Response` with mutable headers, the `302` with `new Response(null, …)` rather than
  `Response.redirect()`, and promises that.
- `request.signal` is passed to `get` and `stat`. The body of the `Response` is the stream of `get`,
  so a runtime canceling it on disconnect cancels the provider's request (spec 4.5); the Node bridge
  does so on `close`. An `AbortError` before the `Response` exists is thrown on (ADR 0046). Whether
  each runtime and framework cancels is tested under "When a framework integration counts as
  supported" (#308).
- On Deno, `adapter-s3` and `adapter-azure-blob` hand over a content-coded object as stored, so the
  client receives coded bytes without `Content-Encoding`. Nothing in `ObjectStat` lets the layer
  repair that; it is a divergence the spec states.
- No promise a released package makes is narrowed, so ADR 0017 is not touched.
- The ASCII fallback of `Content-Disposition` was fixed under "Write the v0.5 spec" (#309): every
  character outside `U+0020` to `U+007E`, and `"`, `\`, and `%`, becomes `_`, and `filename*` is
  always sent, so the fallback holds no `%XX` and no `\` that a recipient might decode. An
  `inline` disposition carries the same parameters.
