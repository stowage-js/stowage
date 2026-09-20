# The payload hash comes from a buffered part

`@stowage/adapter-s3` computes `x-amz-content-sha256` by holding a part whole and hashing it with
one call to Web Crypto's `digest`. The Web Cryptography API defines SHA-256 as a one-shot operation
over a `BufferSource` and has no incremental form, so every alternative either avoids hashing the
body or uses an API outside the standard.

ADR 0002 already spends the memory this costs. It fixes the part size as the memory limit of an
upload on every line, because below undici 8.6.0 Node's `fetch` retains a request body whole.
Buffering a part in order to hash it therefore spends memory that is already committed rather than
new memory, and it answers a second requirement of the same ADR: a part that has been read is a part
whose length is known, and an adapter never hands `fetch` a body stream of unknown length.

`UNSIGNED-PAYLOAD` was the cheapest alternative and gives up what the hash buys. S3 checks a signed
body against the hash, so a check on every request stowage sends is a side effect of signing rather
than a feature, and without it a part that arrives corrupted is stored. It also fails against a
hardened bucket: the condition key `s3:x-amz-content-sha256` lets a bucket policy deny that exact
literal, and an adapter that sends nothing else has no second way in.

Chunked signing (`STREAMING-AWS4-HMAC-SHA256-PAYLOAD`) is the only option that lowers the limit to
the chunk size, and R2 does not accept it. Cloudflare's release note of 2022-04-14 announces support
for _unchunked_ signed payloads, and two of its own SDK examples describe the `403` that the Java
SDK's chunked default produces. Using it would mean two paths through the signer and two memory
statements for one parity core.

A per-runtime hasher behind a seam covers all four runtimes v0.1 promises — `node:crypto`,
`Bun.CryptoHasher`, `DigestStream` — and buys the same limit that chunked signing buys, for four
code paths and the end of the statement that the adapter runs on web standards alone.

What is chosen instead cannot be unavailable: one-shot `digest` exists in every runtime, so the
question of what happens where the strategy is missing does not arise.

## Consequences

- The default part size is 8 MiB and is configurable. The memory an upload occupies is that size
  times the number of parts in flight.
- A part is read into one `Uint8Array` allocated at part size, rather than collected as a list of
  chunks and joined before hashing. `digest` takes one contiguous `BufferSource`, and joining
  afterwards would hold the part twice, which would make the number above twice the part size. A
  body shorter than a part allocates only what it needs.
- The part size is fixed before the first part and does not change during an upload, because R2
  requires every part except the last to be the same size. Where the total length is known, the
  adapter raises the size up front so that 10,000 parts cover the object.
- A stream of unknown length keeps the configured size and fails once the object needs more than
  10,000 parts, which is about 78 GiB at the default. The error names the part size that was set and
  the two ways past it, a known length or a larger configured size. Raising the default for unknown
  lengths instead would charge every small upload the memory of the largest conceivable one.
- Two thresholds separate a single `PUT` from a multipart upload. A body of unknown length becomes
  multipart once it fills one part, because buffering further spends memory nobody asked for. A body
  whose length is known goes as a single `PUT` up to 5 GB, the lower of the two providers' limits,
  since its bytes are already in memory and splitting them costs round trips and saves nothing.
- Presigned URLs sign `UNSIGNED-PAYLOAD`. SigV4 specifies that for a query-signed request and the
  signer never sees the body, so this is a property of presigning rather than a second strategy. A
  presigned `PUT` carries no integrity check unless the caller signs a checksum header into it, and
  against a bucket whose policy denies `UNSIGNED-PAYLOAD` it cannot work at all. Reference flow 2
  depends on the bucket allowing it.
- There is no option to sign `UNSIGNED-PAYLOAD` on a request stowage sends. It would trade the
  integrity check for throughput that has not been measured, and give the conformance suite a second
  path to cover.
- There is no `Hasher` interface. One function over bytes is the whole surface, and a seam there
  would not catch what a later change touches anyway: chunked signing replaces the body framing and
  the `Content-Length` arithmetic along with the hash.
- v0.1 sends no `x-amz-checksum-*` header. S3 rejects a part that does not match its signed hash, so
  a CRC32 beside it checks the same bytes of the same request a second time. AWS made checksums a
  default in its SDKs in December 2024 and left the service accepting uploads without one. R2 lists
  the algorithms but documents them for no individual operation, and states that `CopyObject` takes
  no checksum algorithm at all, so promising them would be a claim the conformance suite cannot
  check against a promised provider. CRC32 and CRC32C are table-driven register updates that need no
  crypto API, which makes them the portable check to add if `UNSIGNED-PAYLOAD` ever wins.
- A buffered part stays re-sendable, which is what the retry ADR 0003 promises needs for an upload:
  a retried part goes out from the buffer rather than from a stream that has moved past it.
- The part size limit stands while both promised providers do. Chunked signing lifts it for AWS
  alone, so it would split the parity core here rather than raise it. It is worth building once R2
  accepts streaming SigV4, or once the part size costs enough on AWS to justify two memory
  statements.
