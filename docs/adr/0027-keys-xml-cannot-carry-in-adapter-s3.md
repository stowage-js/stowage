# `adapter-s3` reads a character reference to any scalar value and deletes a key XML cannot carry on its own

ADR 0010 lets a writable key hold `U+FFFE` and `U+FFFF`, and ADR 0020 keeps them allowed for the
Azure adapter. The portable case `list/noncharacter-key` writes, lists, reads and deletes such a
key on every adapter. XML 1.0 carries neither character, raw or as a reference, and S3 offers
`encoding-type` on the listing alone, which `adapter-s3` now sends on every `ListObjectsV2`. Two
places remain where `adapter-s3` fails on such a key. S3 writes a character XML cannot carry into
an answer without `encoding-type` as a numeric reference, as `&#x7;` in a `CreateMultipartUpload`
answer captured in 2025, and the parser refuses `&#xFFFE;`: a streamed `put` then rejects after its
commit, and `delete` loses its per-key report. And the `DeleteObjects` body carries the key raw,
which is not well-formed XML. SeaweedFS answers it with `MalformedXML`, and AWS answered a raw
`U+0010` there the same way.

Narrowing the case was the alternative, by refusing both characters in a writable key or by
confining the case to the listing, and it relieves nothing. An addressable key cannot be refused,
since other tools may have written it, and `deleteAll` deletes what it lists, so the delete path
needs the repair either way. Refusing a key that v0.1 accepts would also be a breaking change under
ADR 0017, taken against ADR 0020's decision for a problem that has a known remedy.

The parser accepts a numeric character reference to any Unicode scalar value except `U+0000`. A
surrogate and anything above `U+10FFFF` stay an error, as do CDATA and DTDs. This amends ADR 0003,
whose subset named "numeric entities" and which the parser read as XML 1.0's `Char`. The rule
belongs to the parser that ADR 0019 moves into `@stowage/core`, so it holds for the Azure adapter
as well, which meets these characters percent-encoded under `Encoded="true"` and neither gains nor
loses. `&#xFFFE;` then reads as `U+FFFE`, the key byte for byte, whatever S3 writes into the
multipart and `DeleteObjects` answers. Replacing the reference with `U+FFFD` was the alternative:
it keeps the multipart answers readable, but reports a per-key failure against a key the caller
never passed. Departing from XML 1.0 here is deliberate. Every conformant parser measured refuses
the reference, expat, Go's `encoding/xml` and libxml alike, and that refusal is why botocore, the
Go SDK and minio-go cannot handle such a key.

A key holding a character outside XML 1.0's `Char`, which in the key space means `U+FFFE` or
`U+FFFF`, leaves the `DeleteObjects` batch and goes as a `DELETE` of its own. The key travels
percent-encoded in the path, as it does for `put` and `get`, and no XML parser at the provider sees
it; boto3's maintainer pointed to the same route. These requests go after the batches, one after
another, each on the budget of section 7.5. A `204` counts as deleted. A failure that ADR 0005
names as one of the request as a whole rejects the call and stops the requests after it, as a
failed batch does; any other failure becomes the key's entry in `failed`, with the code section 7.9
maps. Writing `&#xFFFE;` into the body was the cheaper alternative, one request for the batch
rather than one per key, but that body is not well-formed XML either, and whether AWS and R2 accept
it is unverified.

That conflicts with ADR 0017. Section 4.1 of v0.1 promised at most one request per 1000 keys, and
1000 such keys now cost 1000 requests. ADR 0020 already took the batch size out of the core, which
promises batches with one request each, so the core promise holds word for word; the number moves
in `adapter-s3`'s own statement, which reads "at most one request per 1000 keys, plus at most one
per key holding `U+FFFE` or `U+FFFF`". A caller whose keys hold them is promised less than v0.1
promised, so this is a withdrawal, and it joins the `**Breaking:**` changeset ADR 0020 requires for
v0.2. That a v0.1 batch holding such a key could not succeed does not exempt it: SeaweedFS refuses
that body, but AWS and R2 were never measured with it, and a withdrawal does not depend on whether
code moves. The statement says "at most" on purpose: it states a cost, as ADR 0020 has the batch
size do, and leaves room to batch these keys again without a change to the spec.

## Consequences

- The `**Breaking:**` changeset of v0.2 states `delete`'s request count for `adapter-s3` in one
  entry: the batch size leaving the core under ADR 0020, and the added `DELETE` per such key.
- Section 7.4 says that every answer document goes through the parser, not only a listing, and
  that it accepts named entities and numeric character references to any Unicode scalar value
  except `U+0000`.
- Error documents do not change. `error-document.ts` already decodes any reference and never fails
  on content.
- A `200` to `CompleteMultipartUpload` whose body fails to parse still counts as a failure followed
  by an abort. After this decision no spelling of a key reaches that path, and section 7.7 keeps its
  one ambiguous outcome.
- `adapter-s3`'s tests gain `&#xfffe;` in both multipart answers, `<Error><Key>` holding
  `&#xfffe;`, `&#xffff;` and `&#65534;`, and a `delete` that sends a `U+FFFE` key as `DELETE` while
  its neighbours stay in the batch. The parser's tests keep refusing a surrogate, `&#x0;` and
  `&#x110000;`.
- SeaweedFS exercises the separate `DELETE` on every commit. The parser rule rests on unit fixtures
  alone, because SeaweedFS writes `U+FFFD` where S3 writes a reference.
- The first scheduled run against AWS and R2 settles three points, keeping the raw bytes of every
  answer:
  - A `DELETE` of a `U+FFFE` key answers `204` and the object is gone. If a provider refuses it, no
    route deletes such a key there, the real endpoint has disproved the promise, and ADR 0017
    withdraws it in a minor: `adapter-s3` refuses `U+FFFE` and `U+FFFF` in a writable key as
    `InvalidKey`, and `list/noncharacter-key` narrows to the listing for S3. That change then names
    its conflict with ADR 0020.
  - A quiet `DeleteObjects` body holding `&#xFFFE;`, and one holding `&#65534;`. If AWS and R2 both
    accept one spelling and delete the object, these keys go back into the batch without a change
    to the spec. Otherwise nothing changes.
  - How the multipart answers, and `<Deleted><Key>` without `Quiet`, spell the key. This is
    recorded only, since no spelling changes the decision.
