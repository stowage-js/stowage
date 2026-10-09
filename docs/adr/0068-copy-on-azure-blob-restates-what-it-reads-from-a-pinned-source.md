# `copy` on Azure Blob restates what it reads from a pinned source

ADR 0025 had `copy` send one `Put Blob From URL` and let the service copy the source's properties,
with no `HEAD` in front of it. ADR 0059 found that the service turned a stored
`Content-Language: de-AT, en` into `de-AT,en`, and narrowed section 4.11 for `contentLanguage`
rather than pay for a `HEAD`. The scheduled run on `b8f641f` then failed `copy/content-headers`
and `move/content-headers` against the account, because
`attachment;\tfilename="conformance  report.pdf"` came back as
`attachment; filename="conformance  report.pdf"` (#422). This reverses both decisions.

A probe against the account on 2026-10-09, at `x-ms-version` 2026-04-06, measured what the copy does
to each property in 166 cases, none of them refused. `Put Blob From URL` parses five properties of
the source and stores a canonical form of each one that parses:

- `Cache-Control` loses the whitespace around `,` and `=`, and its directive names are lowercased.
  Known directives are reordered, `no-cache, no-store` becoming `no-store, no-cache`, and numbers
  are normalized, `max-age=060` becoming `max-age=60`. A repeated `max-age` keeps the last value.
  The quoted field list of `private` or `no-cache` is split on whitespace, `private="a  b"`
  becoming `private="a, b"`.
- `Content-Disposition` and `Content-Type` lose the whitespace around `;` and `=`, joined with
  `"; "`: `attachment;\tfilename=` becomes `attachment; filename=`, and `text/plain;charset=utf-8`
  becomes `text/plain; charset=utf-8`. Case, duplicate parameters and quoted strings are kept.
- `Content-Language` and `Content-Encoding` lose the whitespace and the empty elements around `,`,
  joined with `,`: `gzip, br` becomes `gzip,br`.

A value that does not parse, such as `attachment;` or `public; max-age=60`, is copied byte for byte,
and so is the user metadata. `Put Blob` and `Put Block List` store every one of these as sent. ADR
0059's statement that `Cache-Control: public, max-age=60, immutable` kept its spaces was true only
because that value was canonical already, and the conformance case wrote no other.

Narrowing section 4.11 again was the alternative ADR 0059 would have suggested. The promise would
have had to read "equivalent under the grammar of each header", which the suite cannot assert
without a parser for each of three grammars, and two of the rewrites change what a cache reads: RFC
9111 has a repeated `max-age` taken first or the response treated as stale, not the last value, and
`private="a  b"`, which names no valid field, becomes a list of two. The narrowing would sit in the
parity core, for every caller and every third-party adapter, to spare one provider one request. The
rewrite of `contentType` breaks a promise that v0.5 already makes, and no narrowing of a released
promise is open under ADR 0017.

A property restated on `Put Blob From URL` as `x-ms-blob-*` is stored byte for byte, the
properties not restated are still copied from the source, and the user metadata is copied
regardless. `copy` therefore sends a `HEAD` to the source first and restates on the copy each of
`Content-Type`, `Content-Encoding`, `Cache-Control`, `Content-Disposition` and `Content-Language`
that the `HEAD` returned. A property the source lacks is not restated. Restating only the
properties the service was seen to rewrite would tie the adapter to a parser the service does not
document.

ADR 0059's second reason against the `HEAD` was the race in which a source replaced between the
`HEAD` and the copy pairs the new body with the old properties. ADR 0025 could leave the source
unpinned because nothing read by a `HEAD` went into the copy, and that no longer holds. The copy
carries `x-ms-source-if-match` with the ETag of the `HEAD`. A source replaced in between is
answered `412 CannotVerifyCopySource` with `x-ms-copy-source-status-code: 412`, and the destination
stays as it was. ADR 0013 does not repeat a `412`, and a request with the same ETag would fail
again, so the adapter repeats the `HEAD` and the copy itself. A copy that reads any whole version of
the source keeps section 4.11, and a caller should not meet a failure that S3 and GCS never give
only because another writer is replacing `from`. Three attempts in all, the budget of ADR 0013,
bound it. After the third, the copy rejects with `ProviderError`,
`providerCode: "CannotVerifyCopySource"`, `retryable: true` and `attempts` counting every copy it
sent, since a later call may meet a quiet source. Rejecting on the first `412` was the alternative,
and would hand the caller a retry the adapter can make.

The `HEAD` also turns a missing source into `NotFound` before anything is written (`404
BlobNotFound`). The mapping of `CannotVerifyCopySource` by the source's status that ADR 0025 set
up stays, for a source deleted between the `HEAD` and the copy.

## Consequences

- `copy` and `move` on Azure cost one request more: the `HEAD`, a read billed on the source.
  S3 and GCS still copy in one request.
- Section 4.11 promises `cacheControl`, `contentDisposition` and `contentLanguage` byte for byte
  after `copy` and `move`, without the exception for a `contentLanguage` list. Section 8.7
  describes the `HEAD`, the pin, the restated properties and the repeat, and section 8.8 lists the
  `412`. That amends ADR 0059's paragraph on `Put Blob From URL` and its first consequence, and
  the paragraph of ADR 0025 that sends no `HEAD`; the rest of both stands.
- The shared `cacheControl` of the content-header cases becomes `max-age=60,\tpublic, immutable`,
  which is valid under RFC 9111 and section 4.3, and which the service would rewrite to
  `public, max-age=60, immutable`. `copy/content-headers` and `move/content-headers` also write
  `contentType: "text/plain;charset=utf-8"` in the half with `contentHeaders`, and compare every
  value byte for byte; the comparison of `contentLanguage` as a list goes. The half without the
  capability asserts no type, since `adapter-fs` derives it from the key (spec 6). Both cases are
  new in v0.6, so the change carries no `**Breaking:**` line.
- The harness test of `adapter-azure-blob` that asserts a content-coded object's coding as written
  (ADR 0064) copies an object stored with `gzip, br` and expects `gzip, br` back.
- The repeat after a stale pin is tested against a stubbed `fetch`, as ADR 0016's refusal above
  5 GiB is: no run against the account replaces a source between two requests on purpose.
- The changeset of `adapter-azure-blob` names the repaired `contentType` as a fix of v0.5's
  `copy` and `move`, beside the content headers.
- The cases that send a copy stay divergent on Azurite for the reasons of ADR 0025, so the scheduled
  run remains the only check of the restated properties under an access token. `copy/missing-source`
  and `move/missing-source` leave the divergence list: the `HEAD` answers them before Azurite meets
  the copy, so they now run on every commit.
