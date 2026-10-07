# `serveObject` serves stored content headers where they cannot override a safe default, and a length where no coding stands in its way

ADR 0058 gave `ObjectStat` the three content headers and ADR 0061 the stored coding. ADR 0048 had
answered without either: `Cache-Control: private, no-cache` and `attachment` by default, and no
`Content-Length` on a `200` or a `HEAD`, because the layer could not tell a content-coded object
apart. This records what `serveObject` and `redirectToObject` do now that both are known.

A stored header is not the application's word. Every provider stores a header a client adds to a
presigned `PUT` without the URL signing it, measured on AWS and GCS for all three and on Azure
for the `x-ms-blob-*` forms (`docs/research/content-headers-presign.md` on
`research/content-headers-presign`), and another tool may have written the object for a purpose
of its own. So each header is decided by what a hostile or foreign value could do with it.

`Content-Language` can do nothing, has no default and no option, and is sent as stored.

`Content-Disposition: attachment` is the default that keeps an uploaded `text/html` or
`image/svg+xml` from running with the application's origin (ADR 0048). A stored value is sent only
where its type is `attachment`, the first token before `;`, compared without case, and only where
the caller passes neither `filename` nor `disposition`. A stored `inline`, or anything else, falls
back to the layer's default. The value it serves is the one an application keys by UUID needs: the
name it stored at `put`, which the caller would otherwise look up and pass as `filename` although
`serveObject` already holds it. An uploader gains no more than the name a download is saved under.
Sending the stored value whatever its type was refused: it hands the uploader the inline rendering
the default exists to deny.

`Cache-Control: private, no-cache` rests on the caller checking the client's rights before calling.
A stored `public, max-age=31536000` would let a shared cache in front of the application hand one
user's object to everyone, silently, for every object a client or a public-website tool wrote that
way. The stored value is therefore served only where the caller passes `storedCacheControl: true`;
then it wins, then `cacheControl`, then the default. Ignoring it altogether would have left the
destination of the v0.6 map unmet for the header a caller most often stores. Taking it in
`cacheControl`, as a sentinel string or a function of the `ObjectStat`, was refused: `"stored"` is
itself a valid cache directive, and a function is the hook ADR 0046 built the layer without.

With the coding known, the length returns. Where `contentEncoding` is missing, the bytes `get`
hands over are the bytes stored, and `size` comes from the `stat` of that same `get`; `adapter-fs`
reads exactly `size` bytes, so the body cannot run longer and be cut by Node and Deno as ADR 0048
feared, and a shorter one ends in a reset, which is true of an incomplete answer. Bun replaces a
declared length by the real one or drops it for a body still streaming, and `workerd` drops it on
every stream body (`docs/research/http-serving-semantics.md` on `research/http-serving-semantics`);
`FixedLengthStream` would keep it on `workerd`, unmeasured and specific to one runtime, so the layer
does not use it. Where `contentEncoding` is present, the bytes arrive decoded on Node, Bun and
`workerd` and as stored on Deno through `adapter-s3` and `adapter-azure-blob`, and the layer cannot
tell which (ADR 0061), so the answer carries neither `Content-Length` nor `Content-Encoding`.

`redirectToObject` stays as it is. Mirroring the `attachment` rule would cost a `stat` before every
presign, which today sends no request, and `stat` as a member of `PresignsGet`, which narrows the
structural type a caller's storage must satisfy. The provider sends the stored `Cache-Control` and
`Content-Language` on its own answer from its own origin, and `Content-Disposition` keeps coming from
the options as `responseContentDisposition`.

## Consequences

- `ServeObjectOptions` gains `storedCacheControl?: boolean`. `serveObject` resolves `Cache-Control`
  as the stored value where `storedCacheControl` is `true` and one is stored, else `cacheControl`,
  else `private, no-cache`; `Content-Disposition` as the caller's `filename` or `disposition` where
  either is given, else the stored value where its type is `attachment`, else the default of ADR
  0048; `Content-Language` as stored, absent where none is. The `stat` the headers come from is the
  one that describes the bytes sent, as for every other header, and a `304` carries them too.
- `200` and `HEAD` carry `Content-Length: size` where `contentEncoding` is missing, and none where it
  is present. A `HEAD` carries what the `GET` would, as RFC 9110 9.3.2 asks. Spec 10.3 states that
  Bun and `workerd` may drop the length of a streamed `200`, and that Bun adds `content-length: 0`
  to a `HEAD` of a content-coded object, which RFC 9110 8.6 forbids and no conformance case reaches,
  since stowage writes no such object.
- `Accept-Ranges: bytes` is left out where `contentEncoding` is present, since ADR 0044 refuses
  every range of such an object. Where the layer calls `stat` before `get`, for a precondition or a
  suffix range, a coded object is planned as `200` and the ranged `get` that would fail is not sent.
  Without that `stat`, the fallback of ADR 0048 from a non-retryable `ProviderError` to one whole
  `get` stays.
- The Deno divergence of spec 10.3 stays: the layer still cannot repair coded bytes arriving without
  `Content-Encoding`, now knowing only that the object is coded, not whether the runtime decoded it.
- `Content-Language`, `Content-Length` and `storedCacheControl` are additions. Two changes narrow
  what spec 10.3 promises in v0.5 and conflict with ADR 0017, so the changeset of `@stowage/http`
  marks them `**Breaking:**`: the download name is no longer always `filename` or the key's last
  segment, since an object stored with an `attachment` disposition is saved under its stored name
  (a caller who wants the old name passes `filename`); and `Accept-Ranges` no longer follows
  `rangeReads` alone.
- Spec 10.4 states that `redirectToObject` does not consult the stored `Content-Disposition`, unlike
  `serveObject`, and that the provider serves the stored `Cache-Control` and `Content-Language`,
  GCS adding `private, max-age=0` to a private object stored without one.
- Which of these the HTTP conformance suite asserts is decided under "Conformance and HTTP cases for
  the content headers" (#375); `serve/whole` and `serve/head` assert no `Content-Length` today and
  change with it.
