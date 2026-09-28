# The core reads a stream into parts behind one function

`adapter-s3` and `adapter-azure-blob` read a streamed body the same way: into parts of `partSize`,
one request if the stream ends within the first, otherwise `concurrency` parts in flight, the next
part read only once one settled, the first failure kept while the rest settle, and the source
canceled with the parts. The Azure adapter went in with a copy of the S3 code, and ADR 0019 puts
what two adapters need on the wire into `@stowage/core` once, stated in spec 4.13 and governed by
ADR 0017 like every other export.

The copies suggested two exports, a `PartReader` and a loop that keeps the parts in flight. That
places the protocol between the two in the spec: a part's buffer is recycled only after its request
settled, the source is canceled whenever the upload stops before the stream ended, and the reader
is released after that. Each rule would be a promise an adapter author has to follow correctly and
that ADR 0017 freezes. The core exports one function, `uploadStream`, instead. The adapter hands it
two callbacks: `whole` for the bytes of a stream that ended within the first part, and `multipart`,
which starts the upload, sends the parts through the `sendParts` it receives, and commits. The
reader, the buffers and the cancellation stay inside the core, so the spec promises one call rather
than the order of five.

What differs between providers stays in the adapter: the requests that start, send and commit, the
part limit, and what follows a failure, where S3 aborts the upload and Azure sends nothing (ADR
0016, ADR 0024). The core refuses a stream above the adapter's `maxParts` with the `InvalidRequest`
that names `partSize`, so the message is written once. Reading the multipart options stays in each
adapter, since the range of `partSize` is the provider's.

## Consequences

- `PartReader` is not exported. A third-party adapter that needs a different parting takes its own
  reader rather than a piece of the core's.
- A change to how parts are read or kept in flight reaches both adapters at once, and the
  conformance cases for streamed uploads run through both on all four runtimes. The core's own tests
  of `uploadStream` run on Node alone.
- `sendParts` hands each part its index from zero. `adapter-s3` numbers its parts from one itself.
