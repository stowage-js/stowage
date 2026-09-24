# Where Azure Blob is narrower, its adapter declares less or refuses more

Azure Blob can serve every operation of the parity core, and at five points it holds less than the
spec promises today. Block uploads and copies are decided on their own. This settles the rest:
user metadata keys, writable keys, the batch size of `delete`, and what
`@stowage/adapter-azure-blob` declares. ADR 0017 governs all of them: a provider promised later
does not narrow the parity core, and what it cannot hold becomes a capability its adapter does not
declare. One of them does not fit that shape, and it is named below.

`userMetadata` now promises keys that are ASCII identifiers, `[A-Za-z_][A-Za-z0-9_]*`, and a new
capability, `userMetadataTokenKeys`, promises the non-empty ASCII HTTP tokens the spec allows
today. Azure requires C# identifiers written in ASCII and answers `content-hash`, `x.y` and `1st`
with `400`. `adapter-s3` and `adapter-memory` declare both names and lose nothing. The Azure
adapter declares `userMetadata` alone, and a key outside identifiers is `Unsupported` naming
`userMetadataTokenKeys`, with `attempts: 0`. What changes is the promise a caller reads off
`declares("userMetadata")` without naming an adapter, which is the weaker promise ADR 0015 built
for `keyBytesPreserved`. Three other shapes lost. The Azure adapter could declare `userMetadata`
and refuse more on top, which is exactly the narrowing ADR 0017 rules out. It could encode a
hyphen into the name, but every other Azure tool would read the encoded name, an underscore would
need escaping too, and the reference flows of ADR 0004 read containers other tools wrote. And
declaring no `userMetadata` at all would refuse metadata Azure stores well. Values stay as they
are: RFC 2047 produces ASCII, and 2 KB sits under Azure's 8 KB. Azure hands a key back in the case
it was written in and S3 in lowercase, which the case-insensitive comparison of the spec already
covers.

The Azure adapter refuses three kinds of writable key with `InvalidKey` and `attempts: 0`, under
ADR 0010, which lets an adapter refuse more than the core rule as `adapter-fs` refuses a segment
above 255 bytes. Those three are a key with more than 254 segments, which is Azure's documented
limit; a segment ending in `.`, which Azure says to avoid without saying what happens to it; and
any character in `U+0080` to `U+009F`, of which Azure forbids `U+0081` and advises against most of
the rest. The line is drawn wide on purpose: loosening a key rule costs nothing under ADR 0017 and
tightening one costs a minor release, so a refusal the first run against a real account shows to
be needless is the cheap mistake. Noncharacters such as `U+FFFE` stay allowed, because a listing
percent-encodes them correctly, and the first run checks them on a write. Addressable keys are not
refused beyond the core rule, since other tools may have written them.

The batch size of `delete` leaves the core, which conflicts with ADR 0017. Section 4.1 promises at
most one request per 1000 keys for every adapter, and Blob Batch takes 256 subrequests. The number
bounds the work of the one call that takes no `AbortSignal`, and it states a cost rather than a
behavior. ADR 0017's shape carries a promise that a storage either keeps or does not, and a batch
size is neither, so a capability cannot hold it. The core promises that `delete` sends its keys in
batches, one request per batch, and each adapter states its size: 1000 for `adapter-s3` and 256 for
the Azure adapter. A caller of `adapter-s3` keeps the number they have, and only code written
against `Storage` without an adapter loses it. Promising 256 in the core was the alternative,
which every adapter satisfies and which would take the same promise from S3's callers for nothing.

## Consequences

- `capabilityNames` gains `userMetadataTokenKeys` in v0.2, a minor release under ADR 0017. It has a
  meaning only beside `userMetadata`: on a storage that declares neither, a non-empty
  `userMetadata` is `Unsupported` naming `userMetadata`.
- Moving the batch size out of the core withdraws a promise, so its changeset starts with
  `**Breaking:**`, as ADR 0017 requires of every withdrawal.
- The Azure adapter declares `rangeReads` and `userMetadata`. Whether it declares `presignedUrls`
  is decided with SAS. `keyBytesPreserved` is not declared, because the reference is silent on
  Unicode normalization; if the first run shows NFC and NFD as two blobs, declaring it later adds a
  promise and costs a minor release.
- `provider` is `"azure-blob"`. `bucket` is the container name, and the account belongs to how the
  storage is constructed rather than to `bucket`.
- The conformance suite splits the metadata key case: a hyphenated key round-trips where
  `userMetadataTokenKeys` is declared and is `Unsupported` naming it where not. The accepted key
  list of section 8.7 holds on Azure unchanged.
- `adapter-memory` keeps enforcing the core key rule exactly and refuses none of the three Azure
  keys. It is what a third-party adapter is read against, and the Azure refusals belong to one
  provider.
- The README of the Azure adapter lists as limits the missing `userMetadataTokenKeys`, the three
  refused kinds of writable key, and the batch of 256.
