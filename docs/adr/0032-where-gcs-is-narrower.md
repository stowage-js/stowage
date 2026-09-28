# Where GCS is narrower, its adapter refuses more and reads in two requests

The JSON API that ADR 0031 chose serves every operation of the parity core, and at four points it
holds less than the spec promises today: two kinds of object name, the batch size of `delete`, a
`get` that cannot describe its object from the response carrying the body, and objects other
tools stored compressed. Uploads, copies and provider codes are decided on their own. This settles
the rest, and what `@stowage/adapter-gcs` declares. ADR 0017 governs all of it: a provider promised
later does not narrow the parity core, and what it cannot hold becomes a capability its adapter
does not declare. One difference refuses that shape, and it is named below. The points the
reference left open were measured against the measurement bucket on 2026-09-28 before this was
written, on branch `spike/gcs-json-parity`, rather than left to the first scheduled run as ADR 0020
did for Azure.

The adapter declares `keyBytesPreserved`, `rangeReads`, `userMetadata` and `userMetadataTokenKeys`.
An NFC and an NFD name were stored as two objects and listed and read byte for byte, which the
reference never says. The JSON API carries metadata keys as JSON strings, so `content-hash`,
`x.y` and `1st` are stored as sent, and 8 KiB holds the 2 KB of spec 4.3 with room to spare.
`presignedUrls` is declared where the configuration names a way to sign: a key of its own, or a
service account for `signBlob` under a token. A bearer token alone names no one to sign as, so
every presign call behind the declaration would fail, and ADR 0015 lets configuration decide a
capability for that reason. Declaring it always, as the Azure adapter does, was the alternative;
there a token reaches a user delegation key, here it reaches nothing.

The adapter refuses two kinds of writable key with `InvalidKey` and `attempts: 0`, under ADR 0010:
a key starting with `.well-known/acme-challenge/`, and a key holding `U+FFFE` or `U+FFFF`. GCS
answers both `400` ("ACME HTTP challenges are not supported.", "Disallowed unicode characters
present in object name"). Only the prefix is refused, with its slash: below any other prefix the
same segments were stored, and so were `.well-known/acme-challenge-x` and `U+FDD0`, `U+1FFFE` and
`U+10FFFF`. The C1 controls from `U+0080` to `U+009F` are not refused, unlike on Azure, where the
reference forbids `U+0081`. GCS stored, listed and read all 32 of them; Google advises against them
only because XML listings of other tools may mangle them, and refusing a key the service holds for
another tool's sake is the narrowing ADR 0017 rules out. Addressable keys and prefixes are refused
by nothing beyond the core rule. A read or a `DELETE` of a name GCS cannot hold is answered
`404 notFound` on the JSON API, where the XML API answers `400`, and the adapter reads it as the
answer it is: `NotFound`, and a key `delete` counts as deleted. `adapter-fs` reaches the same
result on APFS through its own code table.

User metadata keys are sent folded to lower case, as ADR 0029 has it on Azure, and two keys that
differ in case alone are `InvalidRequest` before any request. The JSON API would keep `A` and `a`
apart, and the XML API merges them into one header, so folding is what makes an object stowage
wrote read the same on both APIs and alike on all three cloud adapters. Keys are handed back as
stored: a map another tool wrote with `A` and `a` returns both, where folding on the way back
would drop a value. Values travel as JSON strings, raw Unicode, since no header lies in the way;
an RFC 2047 encoded word in a stored value is still decoded on the way back, so an object
`adapter-s3` wrote through the XML API reads the same. The cost falls on XML readers: a raw
`grüße` reaches `fetch` on an XML `HEAD` as `grÃ¼Ãe`. Sending encoded words would have moved that
cost to the Cloud Console, gcloud and the client libraries, which all read JSON.

`delete` sends at most one batch request per 100 keys. Google bounds a batch at 100 calls "to
avoid HTTP 400 errors, gateway timeouts, and dropped connections"; the measurement bucket answered
batches of 101 and 1000 small calls, which shows the bound is not enforced and not that more is
safe. ADR 0020 already made the number the adapter's own. A `404` for one key counts as deleted.
A missing bucket answers the same `404 notFound`, in a batch as well, and only the message tells
it apart: "The specified bucket does not exist." against "No such object". The adapter reads that
message and rejects the whole call with `NotFound`, as spec 4.7 requires of a failure of the
request as a whole. Checking the bucket first needs `storage.buckets.get`, which a role scoped to
objects lacks, and accepting a report of every key deleted would have been a withdrawal of 4.7.
Reading a message is fragile, so a test against the real bucket pins it.

`get` sends two requests side by side: the object's resource and its media download. The media
download carries the content type, the ETag and the generation, and no user metadata, so spec 4.5,
under which `stat` comes from the response carrying the body and `get` costs one round trip,
cannot hold as written. The adapter compares the generation of the two answers and, where a writer
replaced the object between them, cancels the body and repeats. That leaves the promise a caller
depends on — `stat` describes the object whose bytes the body carries — and takes the number of
requests out of the core. This conflicts with ADR 0017. "One round trip" is a published promise of
the parity core, and a capability cannot carry it for the reason ADR 0020 gave for the batch size:
it states a cost, not a behavior a storage keeps or does not. The core promises that `stat`
describes the same object as the body, and each adapter states what `get` costs: one request on
`adapter-s3` and `adapter-azure-blob`, two sent side by side on `adapter-gcs`. Sending them one
after the other, the media download pinned to the generation the resource named, was the other
two-request shape, and it doubles the latency reference flow 4 pays on every download at the same
request count. Downloading from the XML host, whose headers carry the metadata, would have kept
one request and reopened ADR 0031: `get` would have no per-commit endpoint, and raw values would
arrive garbled.

An object another tool stored with `Content-Encoding: gzip` is read decoded on every path. A
`Range` on it meets `200` and the whole decoded body, because the Fetch standard sends
`accept-encoding: identity` beside a `Range` and GCS then ignores the range. That falls into the
rule `adapter-s3` already has for a whole answer to a range: the body stands where the range
covers the object, and anything else is `ProviderError`, whose message here names
`x-goog-stored-content-encoding: gzip`. `rangeReads` stays declared, since stowage never writes
`Content-Encoding` and every object it wrote honors a range.

## Consequences

- `provider` is `"gcs"`. `bucket` is the bucket name; the project belongs to how the storage is
  constructed, if anywhere, and no object operation of the JSON API names it.
- Moving the number of requests of `get` out of the core withdraws a promise, so the changeset
  carrying it starts with `**Breaking:**`, as ADR 0017 requires. Spec 4.5 reads that `stat`
  describes the same object as the body and that each adapter states what `get` costs. No code of
  another adapter changes.
- A configuration without a way to sign declares no `presignedUrls`, while spec 4.9 ties a missing
  declaration to missing methods. Which type such a storage carries, and how a signer is
  configured, is left to the decisions on credentials and presigned URLs.
- `list/noncharacter-key` stays unrun against GCS, as it does for `adapter-fs` on macOS: the GCS
  target leaves it out on both endpoints. It is no divergence, since no real endpoint runs the case
  that would settle an entry (ADR 0034).
- A test of the adapter in the harness asserts, against the real bucket alone, that `delete` in a
  missing bucket rejects with `NotFound` instead of reporting its keys deleted. It pins the
  service's message, which fake-gcs-server need not share, so nothing goes on the divergence list
  for it (ADR 0034).
- The README of the GCS adapter lists as limits the two refused kinds of writable key, the batch
  of 100, the two requests of `get`, the objects stored compressed, and raw metadata values that
  XML readers see garbled.
- `adapter-memory` refuses none of the GCS keys, as it refuses none of the Azure keys.
- ADR 0038 narrows the `404` that counts as deleted to one carrying the reason `notFound`: any
  other `404` on a JSON path is `ProviderError`, so a wrong `endpoint` is not read as an empty
  bucket.
