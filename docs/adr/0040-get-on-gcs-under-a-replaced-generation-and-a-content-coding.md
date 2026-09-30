# `get` on GCS pins at most two requests after a replaced generation, and refuses every range on a compressed object

ADR 0032 sends the resource request and the media download of `get` side by side and, where a
writer replaced the object between them, cancels the body and repeats. It names no bound, so under
a writer that replaces the key faster than the two requests travel the repeat never ends. It also
reads an object another tool stored with `Content-Encoding: gzip` decoded, and passes a whole
answer to a range where the range covers the object. The resource's `size` is the stored size, so
the parity spike read 1000 bytes for a `size` of 39: the body carries more bytes than `size` says,
and the range rules of spec 4.13 measure against the wrong number. `{ start: 100 }` is refused on
an object whose decoded body holds 1000 bytes, and `{ start: 0, end: 50 }` lets all 1000 through.
This settles both and amends ADR 0032.

Where the resource and the media download name different generations, the adapter repeats neither.
It first reads the resource again, pinned with `generation` to the generation the media download
named, and keeps the body, since the body is what the caller reads. Where that answers
`404 notFound`, the generation of the body is gone: the adapter cancels the body and sends the
media download again, pinned to the generation the first resource named, with the caller's range.
Where that answers `404` as well, `get` rejects with `NotFound`, `key` set, the message word for
word, although the key may by then hold a newer object; `get` called again reads that one. ADR 0037
reports a replaced source of a `copy` the same way. A mismatch costs at most two requests beyond
the two sent side by side, one after the other, each on its own budget under ADR 0013, and a `get`
that races a single writer always resolves with an object. `rangeStartRefusal` measures against
the size of the resource that describes the body.

Neither half can be chosen by which generation is newer. Google states that "generation numbers
might not increase for future versions, but each new version has a unique generation number", so
comparing them tells two generations apart and does not order them. Which of the two requests
reaches the service first is left to the network, so pinning only the resource would fail about
half of the mismatches with `NotFound` while the key holds an object. Repeating both requests once
and then failing gives the same bound without reusing what the first answers carried, repeating up
to `maxAttempts` treats a writer as a transient failure, which ADR 0013 does not name, and
repeating until the caller's signal fires is unbounded without a signal. ADR 0032 turned pinning
down for the first attempt because it doubles the latency of every download; after a mismatch it
costs one round trip in the rare case alone. `objects.get` takes `generation` for the resource and
for `alt=media` alike. What it answers for a generation that is gone, replaced in a bucket without
versioning or held by soft delete, the reference does not say beyond the `404 notFound` for an
object that does not exist, so a test against the real bucket pins it. fake-gcs-server 1.56.1
honors `generation` on both paths, answers `404` for a generation that is not the live one, and
sends `x-goog-generation` on every media download.

An object stored with a content coding keeps `size` the stored size, and its body may be longer.
The decoded size is not available to `stat` or `list`, and `get` knows it only once the body has
been read, so the size the provider holds is the one number every operation can report. Spec 4.4
states it for every adapter: `size` counts the bytes the storage holds, and an object another tool
stored with a content coding may arrive decoded and longer than `size`, since `fetch` decodes
content codings on every response. That is a stated limit and no withdrawal under ADR 0017: stowage
never writes `Content-Encoding`, so every object it writes keeps `size` and body alike, and no
capability states the difference. Refusing to read such objects was the alternative, and it would
refuse every object uploaded with `gcloud storage cp --gzip-local` or `gsutil cp -Z`, which static
assets commonly are.

Every range on such an object is `ProviderError`, the body canceled, whose message names the
stored content coding. The adapter knows it from the resource's `contentEncoding` or the media
download's `x-goog-stored-content-encoding`, and the rule holds for gzip, which GCS decodes on the
way out, and for any other coding, which GCS serves as stored for `fetch` to decode, since neither
answer to a range is the stored bytes asked for. The exception ADR 0032 made where a range covers
the object is dropped: it measured against the stored size and let a decoded body through that the
range did not ask for. A range starting at zero without an end asks for the whole object in either
reading and was the one exception left worth weighing; it is not made, so the rule has none.
`rangeStartRefusal` does not run on such an object, and `rangeReads` stays declared, because every
object stowage writes honors a range. Reading the object as stored, with an explicit
`accept-encoding: gzip`, is not reachable: the Fetch standard decodes a content coding on every
response and offers no way out, so a whole answer arrives decoded again, and the spike's `206` of
stored bytes arrived on Node as an empty body. Measuring it on Bun, Deno and `workerd` would
measure the standard.

## Consequences

- Spec 4.4 says that `size` counts the bytes the storage holds and that an object another tool
  stored with a content coding may arrive decoded and longer than `size`.
- Spec 4.5 states the cost of `get` on `adapter-gcs` as two requests sent side by side and at most
  two more, one after the other, where a writer replaced the object between them.
- Spec 9.4 replaces the repeat of ADR 0032 with the two pinned requests, and the rule for a range on
  a compressed object with the one above. Spec 9.2's row on objects stored compressed says `size` is
  the stored size and any range is `ProviderError`. Spec 9.8 names the `404` of the second pinned
  request as `NotFound` with `key`. Flow 4 names the refused range for an object stored with a
  content coding.
- The two pinned requests are covered against a stubbed `fetch`: a newer media download kept with
  its pinned resource, a newer resource answered by its pinned media download, both generations
  gone, and an abort between two requests. A mismatch cannot be provoked reliably against a real
  endpoint.
- A test of the adapter in the harness asserts against the real bucket alone that a pinned
  `objects.get` of a replaced generation answers `404 notFound`, and, for an object written by a
  raw upload with `contentEncoding: gzip`, that `size` is the stored size, the body is decoded, and
  a range is `ProviderError`. stowage cannot write such an object, so no conformance case covers
  it, and nothing goes on the divergence list of fake-gcs-server for it (ADR 0034). The first run
  against the bucket saw a replaced generation answered `404 notFound` on the resource and `404` on
  the media download, on both Node lines.
- The README of the GCS adapter lists as limits that an object stored with a content coding reads
  longer than its `size` and takes no range, and that `get` racing a writer may take up to four
  requests.
- How `adapter-s3` and `adapter-azure-blob` answer a range on an object stored with a content
  coding is not specified in v0.3. The sentence in spec 4.4 holds for them, and changing a released
  adapter is not needed for GCS to fit.
- ADR 0044 replaces the consequence above that leaves `adapter-s3` and `adapter-azure-blob`
  unspecified: they refuse a range on an object stored with a content coding as `adapter-gcs` does,
  through one definition in the core. It also corrects the reasoning about the runtimes, since Deno
  does not decode every coding, so a whole `get` may read the stored bytes. The rule for GCS stands.
