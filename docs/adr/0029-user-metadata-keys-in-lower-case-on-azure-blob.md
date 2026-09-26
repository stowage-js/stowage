# User metadata keys travel in lower case on Azure Blob

ADR 0020 noted that Azure hands a user metadata key back in the case it was written in, and the
v0.2 spec promised that case to a caller of `@stowage/adapter-azure-blob`. The adapter cannot keep
the promise. It reads user metadata off `x-ms-meta-*` response headers, and `fetch` normalizes
every header name to lower case, as the Fetch standard requires of `Headers`, on all four runtimes
of spec 2. A blob stored as `x-ms-meta-WrittenBy` reaches the adapter as `writtenby`. The case
survives only in a `List Blobs` answer with `include=metadata`, where each key is the name of an
XML element.

Reading the case from there would cost a second request after every `stat` and `get`, a listing
by the key as a prefix that answers the key's neighbours too, and a gap between the two requests in
which another writer can replace the blob, so that the description and the metadata come from two
objects. Encoding the case into the name was ruled out by ADR 0020 already, since every other tool
reads the names as they stand. Handing back the case a `put` was given, while `stat` and `get`
answer in lower case, would describe one object two ways. The adapter therefore sends every key
folded to lower case and hands keys back in lower case from `put`, `stat` and `get`, as
`adapter-s3` does. Folding on the way out, and not only on the way back, makes what Azure stores
the same on every runtime, whichever case a runtime puts on the wire, so another tool reading the
container sees the keys a read of stowage returns.

Nothing a caller relies on is lost. Spec 4.3 compares keys case-insensitively, and the conformance
cases read metadata that way; two keys that differ in case alone are refused with `InvalidRequest`
before any request, since folding them would drop a value. This amends ADR 0020 and the promise of
the spec's section 8.2. The adapter is unreleased, so no published promise narrows.

## Consequences

- Spec 8.2 reads "stored and handed back in lower case", and spec 8.4 names the folding and why.
- A blob another tool wrote with a key in mixed case reads back in lower case. `copy` keeps that
  case on the service, which copies the source's metadata as ADR 0025 records, and a read of the
  destination hands it back in lower case too.
- A runtime that exposed the case of a response header would not change the decision, because the
  keys are stored in lower case to begin with.
