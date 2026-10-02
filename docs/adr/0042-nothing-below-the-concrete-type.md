# Nothing lies below the concrete type, and a concrete type gains members in a minor

ADR 0017 makes 1.0 wait until the `raw` escape hatch has a shape, and ADR 0028 keeps that point
beside the measured ones. The shape is none: no adapter hands out a request of the caller's own, its
signer, its credential, or a hook into the requests it sends. A caller who needs to send a request
that stowage does not send signs it with code of their own, such as aws4fetch using the same access key.

The research on `research/raw-escape-hatch` (commit `78d202e`) found what callers reach for below
a portable surface, and nearly all of it is a header on a request the library already sends:
`Cache-Control`, `Content-Disposition`, `Content-Encoding` and `Content-Language` on `put` above all.
Go CDK, `object_store`, OpenDAL and unstorage lifted those into typed options rather than serving
them through a hatch. What must ride on every request, SSE-C, customer-supplied keys and requester
pays, the same libraries configure per store, since a hatch that works one request at a time
writes an object the parity core's own `get` then cannot read. Neither demand is served by `raw`.

A structured request through each cloud adapter's internal `send` was the alternative: the signer,
the credential with its `forceRefresh`, the retry of ADR 0013 and the mapping to `StorageError` of
ADR 0005, handed a descriptor from outside. It exists already and s3-lite-client publishes the same
shape as `makeRequest`. Publishing it would make the descriptor contract from its first release:
an `operation` that has no value for a request outside the parity core, the one-request exception
of `CompleteMultipartUpload`, Azure's account-level requests and headers built per credential, and
on GCS three API paths whose `404` reads differently and a session URI that spec 9.6 keeps inside
the adapter. No conformance case could assert what a provider does with a request the caller built,
and after 1.0 every internal refactoring that touched the descriptor would cost a major. Hooks into
the parity core's own requests were rejected with it: the same `put` would send differently per
adapter, which ADR 0004 keeps off the portable type, and on GCS the content headers travel in the
upload's JSON body, which no header hook reaches. Exporting the signer or the resolved credential
hands secrets out of the adapter. `adapter-fs` could expose a key's resolved path and
`adapter-memory` only its internal map, and a write through either bypasses what the spec promises
about temporary files, the rename and the copy on `put`.

Nothing below the concrete type is only cheap if a hatch can still arrive later without a major.
The concrete types are exported interfaces, and spec 11 counts a change only the compiler sees like
a change in behavior, so read strictly a member added to `S3Storage` after 1.0 would break a caller
who typed a test double as `S3Storage`, and choosing none now would fix the concrete types for the
life of 1.x. They are not written for callers to implement. A factory returns one, nobody outside
its own package produces one, and a double for code that stays portable is typed as `Storage`. So
a member added to a concrete type is a minor release, before and after 1.0, as a name added to
`StorageErrorCode` is. Removing or narrowing a member stays breaking. `Storage` and
`ConformanceTarget` are outside the rule, since adapters outside this repository implement them.
This is stated before 1.0 rather than claimed on the day a member is added, the way ADR 0017
stated the exception for closed unions.

## Consequences

- Spec 4.1 says that no adapter exposes anything below its concrete type. Spec 13 keeps the `raw`
  escape hatch among the non-goals, since no path to one is promised.
- Spec 11 says that a member added to a concrete type an adapter's factory returns is a minor
  release, before and after 1.0, and that `Storage` and `ConformanceTarget` are not concrete types
  in that sense.
- The shape for the `raw` escape hatch leaves the 1.0 gate of spec 11. This amends the list of
  ADR 0017 and ADR 0028: 1.0 waits for section 14 and for the author's own use alone.
- The rule adds an exception to ADR 0017's reading of a change only the compiler sees. It takes
  nothing from a caller today, since below 1.0 a new member is a minor either way, so it is no
  withdrawal and its changeset is not marked `**Breaking:**`.
- A later hatch, typed content headers on `put`, and per-store options for customer keys or
  requester pays each arrive as additions on the concrete type or its options, in a minor release.
  None of them is part of v0.4.
- `@stowage/core` gains no export for a hatch. The signers stay in their adapters (ADR 0019).
- No README names a library for signing a request of one's own. Spec 12 keeps the READMEs outside
  the contract, and nothing in the spec depends on such a line.
- `HttpConformanceTarget` of ADR 0050 is, like `ConformanceTarget`, no concrete type in the sense
  of the member rule: a member added to it is no minor release by that rule (spec section 15).
