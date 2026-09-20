# The S3 adapter implements the wire protocol itself

`@stowage/adapter-s3` speaks SigV4 and the S3 REST API directly and ships no runtime
dependency. The spike reproduced AWS's published signature vectors and bought `PUT`, `GET`,
paged `ListObjectsV2`, `DELETE` and a presigned `GET` in 242 lines;
`@bradenmacdonald/s3-lite-client` reaches multipart, presigned POST and typed error codes in
2185 lines, also without a dependency, so the finished adapter is around two thousand lines
rather than an open-ended amount of work.

What ruled out `@aws-sdk/client-s3` underneath is not its size but its form: every error, every
retry and every stream would pass through its commands and middleware, and the parity core
would end up promising whatever the SDK does. flydrive is built that way, and the survey of
prior art found what it costs — thirteen error classes named after the operation that failed,
with the provider's own error left in `.cause`. Depending on `aws4fetch` instead covers the 129
lines of signing that are verified against AWS's vectors and never change, leaves every S3
operation to this project anyway, and signs `UNSIGNED-PAYLOAD` by default, which is one of the
positions the payload hashing decision still has to weigh.

## Consequences

- No published package has a runtime dependency. Packages under `@stowage/` may depend on each
  other, and the S3 path declares no peer dependency. `@aws-sdk/client-s3` is a development
  dependency, used in tests as the oracle the signer is compared against.
- v0.1 promises AWS S3 and Cloudflare R2. Other S3-compatible endpoints are expected to work
  and are not promised, because each one promised is a lasting obligation against someone
  else's deviations: the spike already found a different element order and `&#34;` in place of
  `&quot;` on SeaweedFS, neither of which raises an error.
- The adapter retries failures that are safe to repeat, with capped exponential backoff and
  jitter. Retrying is on by default and can be switched off. It is transport behavior rather
  than semantics, so `adapter-fs` retrying nothing keeps the parity core intact. Which failures
  belong in that group is ADR 0013.
- Listing responses go through an XML parser that covers the subset S3 sends — elements, text,
  named and numeric entities — and rejects CDATA and DTDs. The spike's 52-line scanner returns
  a wrong value instead of an error when a document surprises it, keys are user controlled and
  arrive escaped, and the scanner held the only defect the whole spike had.
- Region and endpoint are configuration. Nothing is discovered at runtime: a `301` becomes an
  error that names the region from `x-amz-bucket-region`, which costs one round trip once
  during development instead of a per-bucket cache in production. Addressing is virtual-hosted
  by default, path-style behind a flag, and R2 needs an explicit endpoint either way.
- The endpoint is checked when the storage is constructed: an absolute `http:` or `https:` URL
  with no userinfo, no query and no fragment, and anything else is `InvalidOption` naming the
  option rather than quoting its value. Without that check an endpoint carrying a credential
  reaches `fetch`, which refuses it with `TypeError: Request cannot be constructed from a URL
  that includes credentials` — the Fetch standard requires that on every runtime — so the caller
  meets something that is not a `StorageError` at the first request. It is also the side door
  that ADR 0007's rule about credentials in configuration strings would otherwise leave open.
- The signer stays a module inside `@stowage/adapter-s3`. Publishing it separately would add a
  versioned surface for a single consumer, and extracting it later costs one release.
- Bundle size is measured for the release and recorded in the README. It is not a promised
  number, so it carries no weight in this decision.
- Owning the wire protocol is the rule for adapters that follow. One may depend on a library
  where its authentication is out of reach of web standards, and says so in its own ADR.
- `@stowage/adapter-s3-sdk`, built on the official SDK, is the way back. It is worth building
  once a promised provider needs behavior that cannot be written here in reasonable time, or
  once wire-level defects reach users repeatedly instead of the conformance suite. It would
  carry its own ADR and pass the same conformance suite as every other adapter.
