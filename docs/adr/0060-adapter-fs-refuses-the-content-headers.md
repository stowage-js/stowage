# adapter-fs refuses the content headers under a capability it does not declare

ADR 0058 put `Cache-Control`, `Content-Disposition` and `Content-Language` into the parity core and
left a storage that cannot hold them to a capability it does not declare. ADR 0059 found that the
three cloud adapters need none. This records what `adapter-memory` and `adapter-fs` do.

`adapter-memory` stores the three as written and returns them byte for byte from `put`, `stat`,
`get`, `copy` and `move`. It holds more than the parity core promises for `contentLanguage`, whose
whitespace around commas a copy may lose on Azure, and that is its place: it is what a third-party
adapter is read against (ADR 0008), and the conformance cases are written against the providers,
not against it. The checks of ADR 0058 run in the core and refuse the same values here as anywhere.

`adapter-fs` has nowhere to put them. A sidecar file was ruled out with user metadata in ADR 0015,
because the reference flows read directories other tools wrote. Extended attributes have no API in
Node, Bun or Deno without a native addon, and `cp`, `tar` and `rsync` drop them unless told not to.
Accepting the headers and dropping them, as `adapter-fs` does with `contentType`, is the silent loss
ADR 0015 refused for user metadata: the write succeeds, the read comes back without the
`Cache-Control: immutable` or the `attachment`, and the difference surfaces in production. The
content type is kept weakly only because it can be derived from the key; nothing derives a cache
policy or a language. So `adapter-fs` refuses them.

The capability is one name, `contentHeaders`, for all three. No provider and no adapter holds some
of them and not the others, and the glossary already treats the three as one term. `adapter-memory`,
`adapter-s3`, `adapter-azure-blob` and `adapter-gcs` declare it; `adapter-fs` does not.

Where a storage does not declare `contentHeaders`, any of the three options holding a value other
than `undefined` is `Unsupported` naming `contentHeaders`, before signing, with `attempts: 0`, and
before the form and size checks of ADR 0058. That is the first step `userMetadata` takes: what a
storage cannot hold it does not check, so `cacheControl: ""` is `Unsupported` on `adapter-fs` and
`InvalidOption` on `adapter-memory`. Across the option groups, `contentType`, `userMetadata` and the
three headers, the spec keeps naming no order. Reading never refuses: `stat` and `get` on
`adapter-fs` report none of the three, the members absent as they are on any object stored without
them.

The case without the capability asserts two things. A `put` carrying any one of the three alone is
`Unsupported` naming `contentHeaders` and leaves no object at the key. `stat` and `get` of an
object written without them report all three absent, not present as `undefined`.

Nothing here is a withdrawal. No released package promises the content headers (ADR 0059), and
`capabilityNames` grows in a minor release (ADR 0015, ADR 0017). `adapter-fs` refuses `cacheControl`
today as an option it does not know, with `InvalidOption`, and v0.6 refuses it with `Unsupported`:
the input was never valid, the same move `adapter-memory` makes from `InvalidOption` to success.

## Consequences

- Spec 4.9 gains `contentHeaders` in `capabilityNames` and a row: declared, `put` stores the content
  headers, `stat` and `get` return them, `copy` and `move` keep them; not declared, `put` with any of
  the three is `Unsupported` and reads report none. The list of declarations names it for every
  adapter but `adapter-fs`.
- Spec 4.3 puts the `Unsupported` step in front of the checks ADR 0058 orders.
- Spec 5 has `adapter-memory` declare `contentHeaders` and keep the three byte for byte; spec 6 has
  `adapter-fs` refuse them as it refuses `userMetadata`.
- A third-party adapter that does not declare `contentHeaders` refuses the three as unknown options
  with `InvalidOption` until it changes, so it fails the case without the capability as ADR 0058
  already had it fail the case with it. ADR 0006 prices that at a minor.
- Reference flow 5 moves from `fs` to a cloud provider and carries no content headers, since
  `adapter-fs` reads none. A caller moving the other way and forwarding what `stat` reported is
  refused at the boundary, as with user metadata.
- The release of v0.6 holds no withdrawal from the core, the cloud adapters, `adapter-memory` or
  `adapter-fs`.
