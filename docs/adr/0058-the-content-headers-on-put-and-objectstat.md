# The content headers are three typed options, checked before signing and kept by a copy

v0.6 lets `put` write `Cache-Control`, `Content-Disposition` and `Content-Language` and lets `stat`
report them. The map of the effort (#365) settled one typed option per header and no header map.
This records the shape the three take in the core API, from what AWS S3, R2, Azure Blob and GCS
were measured to store and return (`docs/research/content-headers-providers.md` on
`research/content-headers-providers`).

Each header has one name on both sides: `cacheControl`, `contentDisposition` and `contentLanguage`
on `PutOptions`, and the same three as optional members of `ObjectStat`, the shape `etag` already
has. The names follow `contentType` and the members of the GCS JSON resource, and leave room for
`contentEncoding` beside them. A member is missing where the object holds no value. An empty string
is no value: AWS stores `Cache-Control:` as empty, R2, Azure and GCS store it as absent, so `put`
refuses `""` as it refuses an empty `contentType`, and an adapter that reads an empty value reports
the member as missing. There is one state for "no header" on every provider.

The core checks each value before signing, against the rule `@stowage/http` already applies to the
content type of a presigned upload: visible ASCII, with spaces and tabs inside alone. `fetch`
refuses CR, LF, NUL and anything above U+00FF with a `TypeError` that is no `StorageError`, and
trims the whitespace around a value, so the provider would store something other than what the
caller wrote. Azure refuses any byte outside ASCII and R2 a raw Latin-1 byte that AWS stores. The
rule is the one every provider and runtime holds. A file name outside ASCII travels as RFC 8187's
`filename*=UTF-8''…`, which is ASCII, and the caller encodes it; stowage offers no helper. The core
checks no syntax, because no provider does: `max-age=abc` and `attachment; filename=` are stored as
sent on all four, and a stricter core would refuse what every provider accepts. How Azure Shared
Key hashes a tab or a run of spaces is a defect of `adapter-azure-blob`'s signer, not a reason to
narrow the rule.

Two bounds come from the strictest providers. AWS gives the names and values of its system metadata
2,048 bytes together, `Content-Type` included, and answers the next byte with `MetadataTooLarge`;
GCS holds a `Content-Language` of at most 100 characters. Where a `put` carries at least one of the
three headers, the names and values of those it carries and of `Content-Type` hold at most 2,048
bytes together, the content type counted as given or as `application/octet-stream` where absent, and `contentLanguage` holds at most 100 characters. A `put` without any of the three is not
measured at all. Counting the content type always would refuse a 3 KB `contentType` that
`adapter-memory` stores today, a withdrawal that ADR 0017 prices as breaking, for a header the
caller did not touch. Leaving the bounds to the providers would let one storage keep what another
refuses inside the parity core, which promises what all of them hold.

A value that is not a string, is empty or breaks the rule is `InvalidOption` naming the option and
never its value, as for `contentType` today. A bound exceeded is `InvalidRequest`, the code spec
4.10 gives metadata over the limit and spec 7.9 gives `MetadataTooLarge`. Both come before signing
with `attempts: 0`, form before size.

Reading never refuses. A value another tool stored outside the rule, UTF-8 on AWS or 8 KB on R2, is
reported as read, decoded in no way, as an `addressable` key may be read that is no `writable` one.
The `ObjectStat` that `put`, `copy` and `move` resolve with carries the values a later `stat`
reports, whether the adapter takes them from what it sent or from the provider's answer; no provider
echoes them in the answer to a write, and every one stores a value inside the rule byte for byte.

`copy` and `move` keep the headers of the source, which every adapter's request already does, and
take no option to replace them. Replacing costs differently per provider: S3's `REPLACE` restates
everything, the content type and the user metadata included, and so needs a `HEAD` first; Azure's
`Put Blob From URL` takes one header at a time; whether a partial GCS `rewriteTo` body keeps the
rest is not known. Changing the headers of an object that exists is an operation of its own and
stays outside v0.6.

The three headers are part of the parity core, because every promised provider holds them. A
storage that cannot becomes a capability it does not declare, which the adapter tickets of the map
decide. New options on `PutOptions` and optional members on `ObjectStat` are additions: a minor
release without `**Breaking:**`. A third-party adapter keeps compiling, refuses the new options as
unknown under spec 4.3, and fails the new conformance cases, which ADR 0006 prices at a minor.
`ConformanceTarget` gains no factory. `contentType` keeps its rules: giving it the header-value
rule would refuse what `adapter-memory` accepts today.

## Consequences

- Spec 4.3 lists the three options and the order of the checks, 4.4 the three members and the empty
  value, 4.11 has `copy` carry the headers, and 4.13 the refusal function an adapter calls, beside
  `rangeBoundsRefusal`.
- Azure's `Put Blob From URL` turns a stored `de-AT, en` into `de-AT,en`, so a copy does not keep
  every `contentLanguage` byte for byte there. Where a provider differs on the content headers, and
  what its adapter declares, is its own ticket on the map.
- `presignUpload` in `@stowage/http` and the core share one header-value rule, whichever package
  ends up owning it.
