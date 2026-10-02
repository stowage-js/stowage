# The HTTP layer accepts an upload as a bounded `PUT` and presigns one from values the caller hands it

`@stowage/http` (ADR 0046) carries reference flows 1 and 2 through a framework route with two
functions. `acceptUpload` streams a request body into `put`, and `presignUpload` answers with what
`presignPut` returns. Neither takes a hook. Authorization and naming the key happen before the call,
the size limit, the content type and the user metadata are options, and whatever follows a stored
object, a database row or a check of its first bytes, happens after the call through
`objectStatOf(response)`.

`acceptUpload` accepts `PUT` alone. A cross-site HTML form cannot send `PUT`, and a cross-origin
`fetch` with `PUT` is always preflighted, so an upload route behind a session cookie is safe from
form-based CSRF through its method alone. Accepting `POST` would have let a cross-site form post a
`text/plain` body that no preflight stops, and the layer would then have needed an `Origin` check
that ADR 0046 leaves with the caller. With `PUT` alone, a browser form's `multipart/form-data`
cannot arrive either, so the layer refuses no content type.

No framework bounds a streamed body without buffering it. Hono's `bodyLimit` reads a body without
`Content-Length` into memory before the handler runs (`research/hono-integration`, commit
`b9feab7`). Fastify streams a body only through an application-wide content type parser, which
switches its `bodyLimit` off (`research/nestjs-integration`, commit `15b6565`). A Next.js Proxy
matching the route cuts the body at 10 MB and still answers `200` (`research/nextjs-integration`,
commit `be1540b`). So the layer counts the bytes between `request.body` and `put`, and errors the
stream before `put` sees its end once the count passes `maxSize` or contradicts `Content-Length`.
`put` then rejects, and flow 1 already promises that the key is absent or holds what it held
before. `maxSize` is required, as `expiresIn` is on `presignGet`: an upload route without a limit
is an open bill, and only the layer can enforce one while the body streams.

`presignUpload` takes no `Request`, which departs from ADR 0046's wording that every function of
the layer takes one. The caller has to name the key before the call, and to do that it usually
reads the request body, the file name the client sent among it; the layer would find the body
consumed. Defining a request format of its own, a JSON body with `contentType` and
`contentLength`, would have handed every client a protocol stowage then promises, and made a caller
who needs the file name clone the request. Keeping an unused `request` parameter for symmetry would
have promised a dependency that does not exist: `presignPut` sends no request on `adapter-s3` and
takes no `signal` on any adapter.

## Consequences

- `acceptUpload(storage, key, request, options)` takes the portable `Storage`, with `maxSize`
  required (a non-negative integer or `Infinity`), `contentType` and `userMetadata`. Any method
  other than `PUT` is `405` with `Allow: PUT`. A request whose `body` is `null` stores an empty
  object.
- `contentType` absent: the request's `Content-Type`, and without that header the storage's default
  of spec 4.3. User metadata never comes from request headers. A `Content-Encoding` other than
  `identity` is `415`, because no runtime decodes a request body and the coded bytes would be
  stored without their coding (RFC 9110 8.4.1). Any check of the content type is the caller's,
  made on the request's headers before the call without touching the body.
- A `Content-Length` above `maxSize` is `413` before the body is read. A body that passes `maxSize`
  while streaming is `413`; one that ends short of its `Content-Length` or runs past it is `400`.
  A body that fails while it is read, a reset connection among the causes, is `400`. Each is a
  refusal of the layer's own and carries no `StorageError`. A chunked body cut by a Next.js Proxy
  cannot be told apart from a complete one; the README of `@stowage/nextjs` states it.
- `request.signal` is passed to `put`, and an `AbortError` is thrown on (ADR 0046). The Node bridge
  aborts the signal of the `Request` it builds when the Node request closes before the response
  has ended.
- A stored object is `201` with an empty body and the provider's `etag` as a quoted strong `ETag`,
  none where the storage hands over no `etag`. `201` is sent whether or not the key held an object
  before, since telling the two apart would take a `stat` that races the upload.
  `objectStatOf(response)` answers the `ObjectStat` `put` resolved with, and `undefined` for any
  other `Response` and for a copy of one. The body carries no `ObjectStat`, since its `key` and
  `userMetadata` may say more than the client should learn.
- A `StorageError` becomes the status of ADR 0048: `NotFound` with `key` and `InvalidKey` are `404`,
  `NetworkError` and a `retryable` `ProviderError` `503`, everything else `500`, an `InvalidRequest`
  over the adapter's `maxParts` among them, since that is a `maxSize` the caller chose beyond what
  the storage takes. The body is empty and `storageErrorOf` answers the error.
- `presignUpload(storage, key, options)` takes a structural `PresignsPut`, naming `presignPut` with
  `expiresIn`, `contentType` and `contentLength`, beside ADR 0048's `PresignsGet`. Its options are
  `expiresIn`, `maxSize`, `contentType` and `contentLength`, all required. Before signing, a
  `contentLength` that is not a non-negative integer is `400`, one above `maxSize` is `413`, and a
  `contentType` that is empty or no valid header value is `400`, so a client's value never reaches
  `presignPut` as an `InvalidOption` answered `500`.
- A presigned upload is `200` with `Content-Type: application/json`,
  `Cache-Control: private, no-store` because the URL expires, and the body
  `{ "url", "method": "PUT", "headers" }`, `headers` being what `presignPut` returns. A `StorageError` becomes a
  status by the table above.
- Every `Response` of both functions has mutable headers, as ADR 0048 promises for serving, so a
  caller adds `Location` or anything else afterwards.
- On Fastify a body reaches the layer only once a content type parser leaves the payload unread,
  and that parser is application-wide. Who registers it belongs to the shape of `@stowage/nestjs`
  and to the README of `@stowage/http`, not to the layer.
- This amends ADR 0046's wording that every function of the layer takes the web `Request`:
  `presignUpload` does not. Neither ADR is released, so no promise is narrowed and ADR 0017 is not
  touched.
- ADR 0052 adds that `acceptUpload` rejects with a `TypeError` before `put` starts when the
  request's `bodyUsed` is `true`.
- ADR 0046 corrects when the Node bridge aborts the signal: when the Node response closes before it
  has finished, not when the request closes. Node closes the request as soon as its body is read,
  while `put` may still be completing.
