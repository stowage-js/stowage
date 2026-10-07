# The suites assert the content headers a case can write, and leave the rest to the repository

ADR 0058 to ADR 0063 gave `put`, `ObjectStat`, `serveObject` and the presigned uploads the content
headers and `contentEncoding`, and each left to this decision what the conformance suite (spec
14.5) and the HTTP conformance suite (spec 14.9) assert of them. This records the new cases, their
cost, the existing cases that change, what stays a test of this repository (spec 14.4 and 14.8),
and how the release classifies the suites.

A case asserts what the core API lets a caller observe, through what a case can do: write through
the storage, and send a request with `fetch`. Two things fall outside that. A content-coded object
cannot be written through stowage, and a route of the HTTP suite cannot change its configuration
without changing the target. Everything else the content headers promise becomes a case.

## `put`, `copy` and `move`

Three `put` cases and two copy cases require `contentHeaders` and cost `fast`.
`put/content-headers` writes the three and reads them back byte for byte through the `ObjectStat`
of `put`, through `stat` and through `get`. Its values are chosen to catch the defects the
measurements found: `contentDisposition` holds a tab and a run of spaces, which the folding of
`adapter-azure-blob`'s Shared Key signer turned into `403` (ADR 0059); `cacheControl` is
`public, max-age=60, immutable`, a value SeaweedFS parses, so that no divergence is needed for a
syntax no provider checks; `contentLanguage` is `de-AT, en`. A second `put` without them reports
none. `put/content-headers-multipart` carries them on a 17 MiB stream, the other upload path of
every adapter (`CreateMultipartUpload`, `Put Block List`, the resumable start).
`put/content-headers-refused` asserts the checks of ADR 0058, and asserts the bounds from both
sides: exactly 2,048 bytes with `Content-Type` and exactly 100 characters of `contentLanguage`
are stored, the padding in `contentDisposition`, which nothing parses. A bound asserted only from
above would let an adapter refuse more than the strictest provider does.

The halves without the capability assert ADR 0060: any one of the three alone is `Unsupported`
naming `contentHeaders` and leaves no object, `""` is `Unsupported` and not `InvalidOption`, and
an object written without them reports all three absent rather than present as `undefined`.

`copy/content-headers` and `move/content-headers` are two cases, because `move` is a path of its
own on GCS (`moveTo`) and the emulators diverge per path. Both compare `contentLanguage` as a list
whose whitespace around commas may be removed (ADR 0059).

`contentEncoding` is asserted absent on every `ObjectStat` these cases see, in both halves. That
it is present for a coded object stays where the range refusal of ADR 0044 is tested: in each
cloud adapter's harness, on an object written by a signed `PUT` of the harness's own. A factory on
`ConformanceTarget` that seeds such an object was refused: ADR 0058 gave the target no factory for
the content headers, and every third-party adapter would need a writer beside stowage to supply
it.

No existing case of the conformance suite changes. `stat/describes-object`,
`get/stat-from-response` and `copy/round-trip` keep asserting what they assert, and the new
promises sit in new cases, which spec 15 prices at a minor.

## Presigned uploads

`presign/put-content-headers` (`fast`) signs the three, sends the returned `headers` with `fetch`
and has `stat` report them byte for byte. `presign/put-rejects-content-headers` (`slow`, as
`presign/put-rejects-type`) has a value that differs and a value left out each answer `4xx`, since
S3 answers `403` and GCS `400`. Both require `presignedUrls` and `contentHeaders`. Without
`presignedUrls`, the methods are absent, as in every presign case. With `presignedUrls` and without
`contentHeaders`, a `presignPut` carrying one of the three is `Unsupported` naming
`contentHeaders` with `attempts: 0`, and one carrying none still signs: ADR 0063 checks the
options as `put` checks them, and the first step of that check is ADR 0060's.

Whether Azure refuses a differing `x-ms-blob-content-type` under the user delegation SAS of ADR
0063 is no case: the suite names no provider's headers. It is a test of `adapter-azure-blob`
against the account in the `slow` tier, and it settles the section 18 point of ADR 0063. The CORS
rules of the conformance account and bucket gain `x-ms-blob-content-type` alone; the preflight
test keeps sending what `presignPut` returns without the three options, since a browser
honoring a CORS rule is no promise of stowage.

## Serving

`serve/content-language`, `serve/stored-disposition` and `serve/stored-cache-control` require
`contentHeaders`, cost `fast`, and seed through `storage.put`. The first has a stored `de-AT`
answered as `Content-Language` to `GET`, to `HEAD` and on a `304`. The second has a stored
`attachment; filename="stored.pdf"` served as stored and a stored `inline; filename="x.html"`
fall back to the layer's `attachment` with the key's name. The third has a stored
`public, max-age=60` change nothing, since the `serve` route passes no options and the answer
stays `private, no-cache`. Without the capability, `Content-Language` is absent and the defaults
hold.

`serve/whole` and `serve/head` change, because ADR 0062 changed what they assert: both now assert
`Content-Length` equal to the size, strictly. Where Bun or `workerd` drop or replace the length,
the private harness records a server alteration, as it does today for the length these cases
forbid, and spec 2 names it below its second table. A case that accepted a missing length would
assert nothing on Node and Deno, where the layer's answer reaches the client as sent.

Two promises of ADR 0062 and ADR 0063 stay out of the HTTP suite, because asserting them would
change the target. `storedCacheControl: true` needs a `serve` route configured with it, a new value
of `answer`, which spec 15 counts as a new required member of `HttpConformanceTarget`. The content
headers of `presignUpload` need the `presign` route to read them from its JSON body, a new duty of
every target's route. Both are option handling that does not depend on the runtime, so
`@stowage/http` tests them on their own: the order of `storedCacheControl`, `cacheControl` and the
default; `presignUpload` answering `400` for a value outside the rule or a bound; `acceptUpload`
handing the three to `put` and never reading them from the request. What a coded object changes in
`serveObject`, no `Content-Length`, no `Accept-Ranges` and the `200` planned without the ranged
`get`, joins the tests against a storage that answers so (spec 14.8), since no endpoint in CI
holds a coded object.

## Release

The new cases are a minor. `serve/whole` and `serve/head` are not a repair: they assert more of a
server than v0.5 did. A third-party server on Bun or `workerd` that passed them fails them now, and
it has no private list of server alterations. That narrows what `@stowage/conformance` promised a
target and conflicts with ADR 0017, so its changeset carries a `**Breaking:**` line of its own,
beside the two of `@stowage/http` (ADR 0062) and the two of the presigned uploads (ADR 0063). The
changeset of `@stowage/http` describes the layer's answer; the suite's describes what a target's
run meets.

## Consequences

- Spec 14.5 gains, under `put`: `put/content-headers`, `put/content-headers-multipart` and
  `put/content-headers-refused`; under `copy` and `move`: `copy/content-headers` and
  `move/content-headers`; under presigned URLs: `presign/put-content-headers` (`fast`) and
  `presign/put-rejects-content-headers` (`slow`). Each states its half without the capability as
  above, and each case asserts `contentEncoding` absent.
- Spec 14.9 gains `serve/content-language`, `serve/stored-disposition` and
  `serve/stored-cache-control`. `serve/whole` and `serve/head` assert `Content-Length` equal to the
  size in place of none.
- Spec 14.4 extends its entry on the range refusal of a coded object: the same harness tests assert
  that `stat`, `get` and `copy` report the coding as written. It gains the refusal of a differing
  `x-ms-blob-content-type` under the user delegation SAS, against the account in the `slow` tier.
- Spec 14.8 extends its entry on the tests against a storage that answers so with the coded
  object's answer of ADR 0062, and names the tests of `storedCacheControl`, `presignUpload` and
  `acceptUpload` in `@stowage/http`.
- Spec 4.3, 7.10, 8.9 and 9.9 state that `presignPut` on a storage that does not declare
  `contentHeaders` refuses the three as `Unsupported` before any other check.
- The divergence lists gain: on Azurite, `copy/content-headers` and `move/content-headers` under
  `copyUnimplemented`, and `presign/put-content-headers` beside `presign/put`; on fake-gcs-server,
  `move/content-headers` under `moveUnserved` and `presign/put-rejects-content-headers` beside the
  other signature cases. A run that finds SeaweedFS ignoring a signed content header adds its entry
  then; none was measured.
- `harness/targets/src/runtime-alterations.ts` follows the strict length: `lengthOfCompleteBody`
  and `lengthZeroOnHead` no longer match, and `workerd` needs `noLengthOnStream` for `serve/whole`
  and `serve/head`. An alteration fails a run that meets no altered answer, so the build finds the
  final list, and spec 2's notes follow it.
- The changeset of `@stowage/conformance` marks the change to `serve/whole` and `serve/head`
  `**Breaking:**`. v0.6 carries five such lines in all, every other change being an addition.
- Settled under "Write the v0.6 spec" (#376): the suite runs `adapter-azure-blob` under an access
  token (spec 14.2), so no case meets the Shared Key signer ADR 0059 repairs. The tests of the
  account key (spec 14.4) send the content headers of `put/content-headers`, a tab and a run of
  spaces among them, on `Put Blob` and on `Put Block List`, against Azurite on every commit and
  the account in the `slow` tier. Spec 2 names the server alterations the measurements of
  `research/http-serving-semantics` predict: `noLengthOnStream` on `workerd` for `serve/whole`,
  `serve/head` and `serve/range`, and none on `Bun.serve`, which keeps the length of a body
  complete before its headers go out and of a `HEAD` without a body. A run that meets another
  changes the list and spec 2 with it. `put/content-headers-refused` sends a value that is no
  string, `""`, a value with a space at one end, one holding a line feed and one holding `ü`.
