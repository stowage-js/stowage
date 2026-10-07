# `contentEncoding` names the stored coding and changes nothing a read does

The map of v0.6 (#365) settled a read-only report of the content coding another tool stored an
object with, and that `put` never writes one. ADR 0058 left room for a `contentEncoding` member
beside the three content headers. This records its shape, where each adapter takes it from, and
that knowing it changes no read. The providers were measured in
`docs/research/content-headers-providers.md` on `research/content-headers-providers`, section 6.

The member is `readonly contentEncoding?: string` on `ObjectStat`, the value as stored. AWS, R2,
Azure and GCS keep `GZIP` and `gzip, br` as written, and the three content headers are reported
byte for byte (ADR 0058), so this one is too. Lower-casing it would make one header of four
normalized. Splitting a list into an array, or a union of known codings, would repeat what ADR 0044
refused for the range rule: a list that grows with the runtimes. A caller who compares lower-cases,
as RFC 9110 makes content-coding tokens case-insensitive.

The member is missing where the object holds no coding, where the stored value is empty, and where
it is `identity` in any case. AWS stores `Content-Encoding: identity` byte for byte, but `identity`
names no coding, and the member exists so that a caller can recognize a content-coded object. With
`identity` folded into absence, the member is present exactly where ADR 0044 refuses a range, and
`contentCodingRefusal` and the member share one definition of a coding: a value other than empty or
`identity`, in any case. Reporting `identity` as written would have kept the byte-for-byte rule and
made `contentEncoding !== undefined` true for an object nothing coded.

Every `ObjectStat` carries it, from the answer the call already reads, so it costs no request. On
`adapter-s3` and `adapter-azure-blob`, `stat` and `get` take it from the `HEAD` or `GET` under the
`accept-encoding: identity` both send, which R2 needs to keep the stored coding on the answer, and
`copy` and `move` from the `HEAD` of the destination they already send. On `adapter-gcs` it comes
from the object resource, as the range rule does today, and never from the media download, which
drops `Content-Encoding` where GCS decoded gzip. No adapter sends `response-content-encoding` on a
request whose answer feeds an `ObjectStat`, since AWS then reports the override instead of the
stored value. `put` reports none, because stowage writes none. `copy` and `move` report the
source's, because the copy keeps it. AWS, R2 and Azure were measured to report the stored value on
`HEAD`, and the test of ADR 0040 reads the resource's `contentEncoding` against the real GCS
bucket, so section 18 gains no point.

`adapter-memory` and `adapter-fs` report none, always. Neither can hold a content-coded object:
`put` writes no coding and a copy has none to keep. No capability is involved. `contentHeaders`
(ADR 0060) names the three headers a caller writes, not this member, and missing is the truth on
both. `adapter-memory` gains no way to seed one for tests.

Knowing the coding changes nothing `get` does. Decoding in the adapter where the runtime did not,
Deno on `adapter-s3` and `adapter-azure-blob`, would make the body uniform for the codings
`DecompressionStream` knows and not for `br` or `zstd`, and the adapter cannot tell whether the
runtime decoded: undici leaves `Content-Encoding` on a response it decoded. Refusing a whole `get`
and reading the stored bytes were refused in ADR 0044, and nothing here changes their reasons. So
the member names how the object is stored, not which bytes arrive. That corrects ADR 0044, which
said such a member "would tell a caller which bytes arrived"; which bytes arrive still depends on
the runtime and the adapter, as spec 4.4 states.

## Consequences

- Spec 4.4 lists `contentEncoding` beside the three content headers, states that it is missing for
  no value, an empty value and `identity`, that `put` never reports one, and that it names the
  stored coding, not the bytes that arrive. Its sentence on `size` refers to the member for the
  objects that may arrive decoded and longer.
- Spec 4.13 states one definition of a coding, which `contentCodingRefusal` and every adapter's
  `contentEncoding` follow.
- Spec 7, 8 and 9 name where each cloud adapter takes it from, and that none sends
  `response-content-encoding` on a request that feeds an `ObjectStat`. Spec 5 and 6 state that
  `adapter-memory` and `adapter-fs` never report one.
- An optional member of `ObjectStat` is an addition: a minor release without `**Breaking:**`. No
  promise is narrowed, so ADR 0017 is not touched.
- The adapter tests of ADR 0040 and ADR 0044 that write a gzip object through a signed request of
  their own also assert that `stat`, `get` and `copy` report its coding as written, and a stubbed
  `fetch` covers `identity`, an empty value and `GZIP`. Whether anything joins the conformance
  suites is decided under "Conformance and HTTP cases for the content headers" (#375).
- What `serveObject` does with a known coding, its `Content-Length` rule of ADR 0048 among it, is
  decided under "serveObject with stored content headers and a known coding" (#373).
- It corrects ADR 0044's remark on what such a member would tell a caller. The rest of ADR 0044
  stands.
