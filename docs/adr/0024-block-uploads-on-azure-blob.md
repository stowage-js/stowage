# A streamed upload to Azure Blob commits by `<Latest>` and leaves its blocks to the service

ADR 0016 decides how a streamed `put` is sent, and ADR 0013 which of its requests are repeated.
Both were written around S3's multipart upload: an upload id that scopes the parts, an abort that
removes them, and a completion that cannot be sent twice. Azure's block upload has none of the
three. Blocks are staged with `Put Block` under ids that belong to the blob name, `Put Block List`
commits the ones it names and discards every other uncommitted block of that blob, and nothing
aborts. This amends both ADRs for `@stowage/adapter-azure-blob`; what they decide for `adapter-s3`
stands.

The body type still decides the shape. A `Uint8Array` or string goes as one `Put Blob` up to
5,000 MiB, and above that Azure answers `413 RequestBodyTooLarge`, which is `InvalidRequest`; the
adapter does not split held bytes. A stream that ends within one part goes as one `Put Blob`, and a
longer one goes as blocks. Shared Key signs the length and Azure refuses a chunked `Put Blob`, so a
body of unknown length could not go as one request even if ADR 0016 allowed it. Every request the
adapter sends therefore carries a body it holds, and ADR 0013's rule that a stream is never sent
again has nothing to apply to.

The option is the same one: `multipart?: { partSize?: number; concurrency?: number }` on the
adapter's options, 8 MiB and four by default, `concurrency` one to sixteen. `partSize` takes 5 MiB
to 4,000 MiB, where S3 takes up to 5 GiB. Azure states no minimum for a block, and the lower bound
stays at S3's so that a value valid on Azure is valid on S3; a smaller part buys nothing but
requests. The upper bound is Azure's largest block. A blob holds 50,000 committed blocks, so a
stream above about 390 GiB at the default fails with `InvalidRequest` naming `partSize`, where S3's
10,000 parts stop at about 78 GiB. The numbers are stated per adapter; the rule is ADR 0016's.

A block id is sixteen random bytes drawn once per upload followed by the part index as four bytes
big-endian, sent as the Base64 of those twenty bytes. Azure requires every id of one blob to have
the same length, and ids are scoped to the name rather than to an upload. An index alone would let
two writers to one key overwrite each other's blocks and commit an object assembled from both. Ids
of varying length would fail the second writer's first block. The length is therefore fixed for as
long as the adapter exists: changing it would make two versions of the adapter collide on one key
for the week the service keeps uncommitted blocks.

With those ids, two writers to one key still end with one whole object of one of them, but the one
that loses may be told. Whoever commits first discards the other's uncommitted blocks, and the other
commit fails with `400 InvalidBlockList`; a `Put Blob` in between has the same effect. On S3 both
writers resolve and the last commit wins. The spec's sentence was never that both resolve, so it is
made exact for every adapter rather than narrowed for one: each writer may resolve or reject, and
the key ends with one whole object written by one of them. That does not narrow the parity core
and so does not touch ADR 0017. The losing writer gets `ProviderError` with `retryable: false`,
and the same goes for `400 InvalidBlobOrBlock`, which a `Put Block` meets when another tool has
staged ids of a different length under the name. The adapter's requests are valid by construction,
so `InvalidRequest` would blame the caller for another writer, and a new error code would widen a
closed union for one provider. Repeating the request cannot help, because the blocks it names are
gone.

`Put Block List` names every block as `<Latest>`, and it is repeated like every other request. A
second commit after a response that never arrived finds each block either still uncommitted or, if
the first commit happened, committed, and commits the same bytes in the same order. `500
OperationTimedOut`, which Azure documents as "may or may not have succeeded", is covered by the same
argument. The exception ADR 0013 makes for `CompleteMultipartUpload`, and the ambiguous outcome
ADR 0016 draws from it, do not exist on Azure. One case remains: if another writer replaces the key
between the lost commit and its repeat, the repeat fails with `InvalidBlockList`, and the caller is
told of a write that did land and was then replaced. That is the concurrent case above, and its
outcome is the one promised there. The commit carries `x-ms-blob-content-type` and the `x-ms-meta-*`
headers, because a `Put Block List` without them resets the type to `application/octet-stream` and
drops the metadata, and a repeat sends the same headers.

Nothing else in ADR 0013 changes. Azure throttles with `503 ServerBusy` and `500
OperationTimedOut`, and both already fall under the status group; `408` and `429` appear in no Blob
error table and stay in it. `Retry-After` is not documented for the Blob service and is not read.
The `retry` option, the budget of three attempts and the curve carry over, and there is no table of
Azure codes. The one repeat under `401 InvalidAuthenticationInfo` is ADR 0021's.

A failed or aborted upload sends no request after it stops. When a block has spent its budget, the
blocks in flight and the source stream are canceled and `put` rejects with that block's error; the
caller's abort does the same and rejects with `AbortError`. `Delete Blob` would remove the staged
blocks only where no committed blob holds the name, and otherwise it deletes that blob. The adapter
cannot know which it faces: a `HEAD` in front leaves the race with a writer that commits in between,
so the cleanup would delete another writer's object. The staged blocks stay until the next commit or
`Put Blob` to the key discards them, or until the service does a week after the last block. They
are invisible to the API: `stat` and `get` answer `NotFound` for a name that holds only uncommitted
blocks, `list` does not show it, and an object already under the key reads as before.

That conflicts with ADR 0017, and the conflict is named here. Flow 1 holds when an upload that fails
leaves no multipart upload behind, and ADR 0005 has a failed multipart upload abort itself. On Azure
the blocks stay and are charged for until the service removes them, and no lifecycle rule reaches
them. What a caller can observe holds on every adapter: the key is absent, or holds what it held
before. The flow keeps that as its condition, and what an upload leaves with the provider is stated
per adapter. Keeping the promise would have meant a cleanup request that deletes other writers'
objects, and moving the condition out of the flow was the alternative to giving the flow up for
Azure.

The conformance suite gets one case, `put/concurrent-writers`, portable and in the `fast` tier. Two
streamed `put`s of 17 MiB, one a pattern A and one a pattern B, write to one key, and the suite
paces both streams through `pull` so that each has staged a part before either commits. Each call
resolves or rejects, at least one resolves, and `get` returns A or B byte for byte. It checks the id
scheme through the promise, which is where ADR 0006 wants it, and holds on every adapter. The cases
of ADR 0016 and `flow/1` hold on Azure unchanged. What the API cannot show becomes tests of this
repository: against a stubbed `fetch`, that `Put Block List` is repeated after a lost response with
the headers it carried; in the `slow` tier against the real account of ADR 0023, that the same
commit sent twice answers `201` and leaves the same bytes, and that a `Put Blob` discards the
uncommitted blocks of its name, as documented and not as Azurite does.

## Consequences

- Section 4.11's sentence on two writers changes wording for every adapter. `adapter-s3`,
  `adapter-fs` and `adapter-memory` keep resolving both writers, and nothing a caller of them does
  changes.
- `InvalidBlockList` and `InvalidBlobOrBlock` join the Azure adapter's code table as
  `ProviderError`, and its README says that on a commit they usually mean another writer won.
- Section 7.7 becomes S3's alone. The Azure adapter has no ambiguous outcome, and a `put` of any
  size can be answered with certainty, except where another writer replaced the key in between.
- A failed upload to Azure leaves its blocks for up to a week with nothing the caller can do about
  it, and the conformance account of ADR 0023 carries them the same way. A key that meets many
  failed large uploads within a week can reach Azure's 100,000 uncommitted blocks and be refused
  with `409`, which is `InvalidRequest`, until a commit or the week clears them.
- The block id length is a promise of the adapter's implementation, not of the API. The README
  does not mention it; the ADR is where a later change has to answer to it.
- Azurite keeps a name's uncommitted blocks across a `Put Blob`, so a later commit there replaces
  the `Put Blob`. No case touches it, and it goes on the divergence list of ADR 0023 only once one
  does.
- `partSize` above 4,000 MiB is `InvalidOption` on Azure and valid on S3. A configuration shared
  between the two adapters stays within 5 MiB to 4,000 MiB.
