# No range of a content-coded object is read, on any adapter

ADR 0040 made every range on an object another tool stored with a content coding `ProviderError` on
`adapter-gcs`, and left `adapter-s3` and `adapter-azure-blob` unspecified. Neither reads
`Content-Encoding` today. What a caller receives for such an object depends on the runtime, not on
the provider. S3 and Azure store the coding as metadata, serve the stored bytes with it, and apply
a range to the stored bytes. `fetch` then decodes what arrives on Node, Bun and `workerd`, and Deno
decodes nothing once the request carries `Range` or `accept-encoding: identity`, which every request
of both adapters does. Given a range, Node reads a truncated prefix without an error when the range
starts at zero and breaks the body when it starts later, Bun and `workerd` break the body, and Deno
reads the stored bytes asked for. A range that covers the stored bytes reads the whole decoded object
on three runtimes, longer than the range and longer than `size`. Spec 4.3 promises that `range` is
honored wherever `rangeReads` is declared, and nothing in it exempts these objects on S3 or Azure.

The points were measured on 2026-09-30 on Node 24, Bun and Deno against the AWS bucket, the R2
bucket and the Azure account of the scheduled run, with objects stored under `gzip`, `br` and `zstd`
by a signed request of the probe's own, since stowage cannot write one. All three answer as the
local origin of the research note did: under the `accept-encoding: identity` both adapters send,
the stored `Content-Encoding` comes back on `200`, `206` and `HEAD`, a range answers `206` with
`Content-Range` over the stored size, and both adapters report on the real endpoints what they
reported against the origin, cell for cell. A start at or beyond the stored size answers
`416 InvalidRange` without `Content-Encoding`. On AWS and Azure `Accept-Encoding` changes nothing.
R2 does not keep to that. Offered `gzip`, it compresses an object stored without a coding and
recodes one stored as `zstd` to `gzip` on the fly, dropping `Content-Length`. Offered Bun's
`gzip, deflate, br, zstd`, it answered some ranges of `br` and `zstd` objects with `206` and no
`Content-Encoding` at all, and others with it. The header the adapters already send for `size` is
also what keeps the stored coding visible on R2, so it is no longer a transfer detail alone.

This makes ADR 0040's rule one rule for every adapter. Where the answer to a ranged `get` names a
content coding, the adapter cancels the body and rejects with `ProviderError`, whose message names
the coding, the message `adapter-gcs` already sends. Every value of `Content-Encoding` other than
`identity`, in any case, names a coding, as on GCS. A narrower list of the codings some runtime
decodes was the alternative: an unknown coding arrives as stored on every runtime measured. But that
list grows with the runtimes, `zstd` joined undici late, and a rule measured against it would change
meaning without a release. The header arrives on the answer the `get` already receives, before the
body is read, so the rule costs no request. It is checked before `rangeCoversWhole`, because a range
that covers the stored bytes of such an object is not the body asked for either. `adapter-fs` and
`adapter-memory` hold no content coding, so the rule holds for them without code.

A start at or beyond the stored size stays `InvalidRequest` on S3 and Azure, the answer spec 4.3
names for every object, because the `416` carries no coding for the adapter to see. On GCS it stays
`ProviderError`, since the resource request sent beside the download names the coding there, and
changing it would change a released error code. Sending a `HEAD` first would align the two at a
request on every ranged `get`, for a call that is refused either way.

Reading the stored bytes was the other shape. AWS and R2 accept `response-content-encoding=identity`
on a signed request and, against AWS's documentation, which names `200 OK` alone, and R2's, which
does not list it, label a `206` with it as well; every runtime then reads exactly the stored bytes
of the range, `zstd` and ranges inside the stream included. It is not taken. Azure offers the
override on a shared access signature alone, which `get` does not use. It would also make a whole
`get` on S3 read stored bytes where Azure and GCS read them decoded, so the same call would hand
compressed bytes to a caller on one adapter and decoded bytes on the others. Bun's `decompress: false` and `workerd`'s
`encodeResponseBody: "manual"` read the stored bytes too, but Node's `fetch` has no such switch.
Leaving today's behavior and stating it was the third: a range that silently reads fewer bytes on
Node is the one outcome a range must not have.

A whole `get` keeps reading what `fetch` hands over, as ADR 0040 decided for GCS: refusing it would
refuse every static asset stored compressed. Spec 4.4's reason, "since `fetch` decodes content
codings on every response", is not true of every runtime. Deno reads the stored bytes under
`accept-encoding: identity`, and on GCS, which sends no `accept-encoding` of its own, it decodes
`gzip` and `br` and passes any other coding through. ADR 0040's remark that measuring Bun, Deno and
`workerd` "would measure the standard" is wrong for the same reason. The rule for GCS does not depend
on it and stands. A `contentEncoding` member on `ObjectStat` would tell a caller which bytes arrived.
It is an addition, and v0.4 adds nothing beyond its four points.

`rangeReads` stays declared on both adapters, as on GCS, because every object stowage writes honors
a range.

## Consequences

- Spec 4.3 states that a range starting inside the size of an object stored with a content coding
  is `ProviderError` on every adapter, and that a start at or beyond it is `InvalidRequest` on
  `adapter-s3` and `adapter-azure-blob`. Spec 4.4 says such an object may arrive decoded and longer
  than `size`, or as stored, depending on the runtime and the adapter.
- Spec 4.13 exports the one definition of the rule, the refusal for a value of `Content-Encoding`,
  which `adapter-s3`, `adapter-azure-blob` and `adapter-gcs` call. Spec 7.2 and 8.2 gain a row
  "Objects stored compressed" like the one of 9.2. Flow 4 names the refused range for every
  adapter instead of for GCS alone. Spec 7.4 gives `accept-encoding: identity` its second reason:
  on R2 it is what keeps the stored coding on the answer.
- This narrows what the spec promised for two released adapters, a conflict with ADR 0017's rule
  that a withdrawal takes something from the caller. `adapter-s3` and `adapter-azure-blob` withdraw
  a range on an object stored with a content coding. The change is a minor below 1.0, and its
  changeset starts with `**Breaking:**`.
- Each adapter is tested against a stubbed `fetch`: a `206` and a `200` naming a coding, the body
  canceled, `identity` read as no coding. A test of each adapter in its harness writes an object
  with `Content-Encoding: gzip` through a signed `PUT` of its own and asserts that `size` is the
  stored size, a whole `get` resolves, and a range is `ProviderError`. It asserts nothing about the
  length of the whole body, which depends on the runtime. stowage cannot write such an object, so no
  conformance case covers it. The emulators have not been measured; what SeaweedFS and Azurite
  answer shows in the per-commit run, and any divergence joins the lists of ADR 0012 and ADR 0023.
- The READMEs of `adapter-s3` and `adapter-azure-blob` list as a limit that an object stored with a
  content coding takes no range and may read longer than its `size`.
- It replaces ADR 0040's consequence that leaves `adapter-s3` and `adapter-azure-blob` unspecified,
  and corrects its reasoning about the runtimes. The rest of ADR 0040 stands.
