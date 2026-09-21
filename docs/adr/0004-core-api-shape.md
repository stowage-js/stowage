# The core API is one bound storage behind a closed interface

A storage is one adapter bound to one bucket, fixed when it is constructed. There is no clone
onto a second bucket and no manager over several of them: another bucket is another storage. For
`adapter-fs` the bucket is the root directory, and for `adapter-memory` it is the instance
itself, so the word means one namespace in every adapter rather than an S3 concept the others
imitate. The alternative — the bucket travelling with every call, as
`@tweedegolf/storage-abstraction` does it — was written out against all five reference flows and
put `{ bucket, key }` into every call site, with `"uploads"` naming an S3 bucket in one line and
a directory below the file system root in the next.

`get` returns a stored object rather than a bare stream. The reference flow that answers a `GET`
from an edge runtime needs the content type for the response header, and an API that returns the
body alone forces a `stat` call in front of it: a second round trip for something the provider
already sent in the same response. The stored object also carries the convenience — bytes, text,
JSON — which removes the reason for a facade class over the adapter. A facade would repeat every
parity-core method a second time and still not carry presigning, which is a capability and not
part of the parity core.

`list` returns one listing that reads two ways: iterated, it yields every object and walks the
pages itself; `page()` performs one call and hands back that page with its cursor. Both readings
have a reference flow behind them, a file browser serving one page and a prefix move walking
everything, and the prior art shows what dropping either costs — `flydrive` returns the token but
lists one page per call, and `@bradenmacdonald/s3-lite-client` paginates internally and returns
the token as the generator's return value, where `for await` discards it. A third reading over
pages was written and then dropped: no reference flow used it.

The core interface is closed. It has no generic parameter, no index signature and no augmentable
registry, so `@stowage/core` describes exactly the operations every adapter supports alike.
Provider options live on the concrete adapter type, which widens the options parameter it accepts
and adds what the parity core does not have. The generic extension map from the concept sketch
was written out and fails at the boundary it exists for: an application holding the widened type
infers `any` for the options and accepts `{ storageKlass: 42 }` without complaint. A registry
keyed on the provider name types correctly but buys it with global module augmentation and a key
per adapter, and R2 speaking S3's wire protocol makes that key a question of its own.

## Consequences

- An application written against `Storage` is portable and cannot pass a provider option. That
  is the rule stated rather than worked around: an option only one provider honours does not
  belong in code that swaps its adapter. Reaching them means naming the concrete type, which is
  a visible act at the call site.
- Adapters extend `Storage` and widen the options parameter. TypeScript accepts the widening,
  so the conformance suite carries the other half: an adapter has to honour the base contract
  for every call the core describes.
- `get` produces the object's description from the same response as its body. S3 sends it in the
  `GET` headers; `adapter-fs` stats the handle it already opened.
- `put` takes a `Uint8Array`, a string or a `ReadableStream<Uint8Array>`, and reports no progress.
  Both follow from the closed interface: a body type is one every adapter has to accept, and a
  progress option would be one every adapter has to honour for a number the caller can count in a
  `TransformStream` of its own. ADR 0016 gives the reasons and keeps the multipart upload it needs
  them for inside the adapter.
- A delimiter shapes a page rather than the iteration. Iterating yields objects alone, which with
  a delimiter is the objects at that level; the pseudo-directories below the prefix reach the
  caller through `page()`.
- `stat` throws when the key is absent, like `get` and `copy` do, and `exists` is the one
  operation that asks without throwing. Which class is thrown is the error hierarchy's decision.
- `delete` is variadic and always answers with a report, so deleting one key and deleting a
  thousand are the same call. Batching is the adapter's job, as it already is for
  `deleteAll(prefix)`.
- v0.1 ships no facade class and no manager over several storages. The reference flow that uses
  two adapters at once holds them as two values.
- Bucket management is not parity core and is not in v0.1. If it arrives it arrives as a
  separate client per provider, because a bound storage has no place to put it and a file system
  has no bucket to create.
- A storage declares what it supports at runtime, on the portable type, which ADR 0015 records.
  The closed core already keeps an operation the parity core lacks off the portable type, which
  leaves that declaration to cover differences inside the core, such as user metadata and range
  reads.
- The stub the decision came from is on the branch `spike/core-api`, commit `cfc771c`: four
  shapes, the five reference flows written against each, and the type errors each shape does and
  does not produce.
