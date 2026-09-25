# stowage

stowage puts object storage providers behind one typed API, so that an application developed
against local disk runs against a cloud provider by changing where the storage is constructed, and
nothing else.

## Language

**Provider**:
The vendor or service that stores the bytes: Amazon S3, Cloudflare R2, Azure Blob, the local
file system.
_Avoid_: cloud, backend, service

**Promised provider**:
A provider v0.1 keeps its promises against: AWS S3 and Cloudflare R2. Another endpoint speaking the
same wire protocol can be configured and is not promised. An adapter is not told which promised
provider it faces.
_Avoid_: supported provider, tested provider, official provider

**Adapter**:
An implementation of the storage API for one provider.
_Avoid_: driver, connector, client

**Storage**:
One adapter bound to one bucket, which Azure Blob calls a container, and the object an application
holds. Another bucket is another storage. Which provider it faces is named where it is
constructed, in code, and from named options rather than from one string that carries several of
them.
_Avoid_: disk, client, connection

**Account**:
The Azure Blob namespace a container belongs to. A storage names it where it is constructed,
beside the container, and it is not part of the credential. S3 has no counterpart.
_Avoid_: tenant, subscription, storage account

**Wire protocol**:
The HTTP API a provider publishes, which an adapter implements directly rather than through
the provider's own SDK.
_Avoid_: protocol, transport, REST API

**Credential**:
What an adapter authenticates a request with, such as an access key and its secret. Its form
belongs to the adapter rather than to the parity core, and differs from one provider to the next.
_Avoid_: secret, key, token

**Object**:
A sequence of bytes stored under a key, together with its content type and its metadata.
_Avoid_: file, blob, entry

**Stored object**:
What `get` hands back: the object's description together with its bytes, readable as a stream, as
bytes, as text or as JSON.
_Avoid_: handle, file, response

**Body**:
The bytes a caller hands `put`, either in hand or as a stream that can be read once. Which of the
two it is decides how the upload is sent and whether it can be sent again after a failure that
would pass.
_Avoid_: content, payload, data

**User metadata**:
Named string values a caller stores with an object and reads back with its description. The
provider keeps them beside the bytes and never looks at them. `userMetadata` says whether a
storage can hold them; `userMetadataTokenKeys` says whether it takes names beyond identifiers.
Without `userMetadata`, metadata writes are refused and reads return none. Without
`userMetadataTokenKeys`, writes with names beyond identifiers are refused while identifier names
remain supported.
_Avoid_: metadata, tags, attributes, headers

**Part**:
One piece of an upload, sent as a request of its own and assembled by the provider into a single
object. Its size is the memory cost of one in-flight part, because an adapter holds a part whole
in order to sign it. Total upload memory is the part size multiplied by the number of parts in
flight. A provider may name it otherwise; Azure Blob calls it a block.
_Avoid_: chunk, block, segment

**Multipart upload**:
An upload sent as several parts and committed in one final request. It belongs to the adapter:
nothing about it reaches the API, so there is no upload to resume and no count of parts to read,
and an upload that does not complete leaves its parts with the provider, which charges for them
until it or a lifecycle rule discards them. Whether an upload can abort itself is the provider's
to offer, not part of the term.
_Avoid_: chunked upload, resumable upload, streaming upload

**Key**:
The full name an object is stored under, written as Unicode characters and measured in UTF-8
bytes. Keys are flat, and the API has no directories. What counts as a legal key depends on
whether stowage creates it or only names one that is already there. Two keys that are equivalent
under Unicode without being equal byte for byte may name one object or two, depending on the
provider.
_Avoid_: path, filename, id

**Writable key**:
A key stowage creates: what `put`, the destination of `copy` and `move` and a presigned `PUT`
accept. It is the narrowest key space every adapter can hold, so a key written against one
adapter can be written against all of them. An adapter may refuse beyond it.
_Avoid_: valid key, safe key, allowed key

**Addressable key**:
A key stowage acts on without creating it: what `get`, `stat`, `exists`, `delete`, the source of
`copy` and `move`, and a presigned `GET` accept. It rules out only what would break the request or
leave the storage, so objects that other tools put in the bucket stay reachable.
_Avoid_: readable key, existing key

**Prefix**:
The leading part of a key, which may be empty and may end anywhere in a key rather than on a
segment boundary. Listing by prefix with a delimiter yields the keys below it and the next level
of pseudo-directories.
_Avoid_: folder, directory, namespace

**Cursor**:
An opaque string naming the position a listing reached, which a later call hands back to
continue from there.
_Avoid_: token, continuation token, page marker

**Listing**:
What `list` returns. Iterated it yields every object and walks the pages itself; asked for a page
it performs one call and hands back that page with its cursor. A delimiter shapes a page, not the
iteration: the pseudo-directories it produces reach the caller through a page alone. Every object
below the prefix appears once across the pages, in no promised order.
_Avoid_: iterator, result, page

**Spec**:
`docs/spec.md`, which states what stowage promises across every published package. A caller may
rely on what it says and on nothing else a package happens to export. It describes the version that
is current rather than the one it was written for, so a reader follows the link their package
carries and reaches the wording that belongs to it.
_Avoid_: documentation, reference, contract

**Parity core**:
The operations every adapter supports alike: `put`, `get`, `stat`, `exists`, `list`, `delete`,
`deleteAll`, `copy` and `move`. An application that stays inside the parity core changes its
adapter without changing its code. Where two promised providers answer differently, the parity core
promises what both of them hold. Promising a further provider does not take a promise away: what
that provider cannot hold becomes a capability its adapter does not declare.
_Avoid_: basic operations, common API, lowest common denominator

**Capability**:
A named point out of a closed set where adapters are allowed to differ, such as presigned URLs or
range reads, which every storage declares for itself. Where a storage does not declare one, it
refuses the call it belongs to rather than answering it differently in silence, or it keeps the
weaker promise the parity core makes at that point.
_Avoid_: feature, feature flag, extension

**Presigned URL**:
A URL that carries its own authorization, so a client holding no credential can call it. It is bound
to one operation on one key, to the content it may carry, and to a moment it stops working — at the
latest when the credential that signed it expires.
_Avoid_: signed URL, temporary link, upload URL

**Error code**:
The name stowage gives a failure, drawn from a closed set that means the same thing in every
adapter. It is what a caller branches on.
_Avoid_: error type, error class, status

**Provider code**:
The string a provider uses for the same failure, such as `NoSuchKey`. It travels on the error
beside the error code, and a caller never matches on it.
_Avoid_: error code, status code, reason

**Transient failure**:
A failure whose cause may be gone a moment later, such as a provider under load or a connection
that broke on the way. Every error states whether its condition is transient, which says something
about the condition and not about whether stowage sent the request a second time.
_Avoid_: temporary error, intermittent failure, flake

**Attempt**:
One request an adapter sends for a single step of an operation. A step that meets a transient
failure may cost several attempts only when the retry policy permits another request, and the error
that reaches the caller says how many attempts went out.
_Avoid_: try, retry, call

**Runtime**:
The JavaScript engine and standard library the code runs on: Node, Bun, Deno, workerd.
_Avoid_: environment, platform, target

**Host**:
A service that runs code on a runtime, such as Deno Deploy, AWS Lambda or Cloudflare's network.
A host inherits what its runtime can do and adds limits of its own. stowage names runtimes, not
hosts.
_Avoid_: platform, provider, deployment target

**Reference flow**:
One of the five call sequences that stowage is designed to support, each of which names the
adapters and runtimes it covers and the conditions under which it counts as supported.
_Avoid_: use case, user story, scenario

**Runtime matrix**:
The grid of reference flows against runtimes that fixes what a release promises. A cell counts as
supported only where the conformance suite covers it, and there is no weaker level below that.
_Avoid_: support matrix, compatibility table

**Conformance suite**:
The published set of cases an adapter runs to show that it implements the API as specified. It
asserts what the API lets a caller observe, and nothing below that.
_Avoid_: compliance tests, adapter test kit, acceptance tests

**Conformance case**:
One assertion of the conformance suite, named and runnable on its own. It states the capability
it needs, what holds against a storage that does not declare it, and how expensive it is to run.
_Avoid_: test, check, scenario

**Conformance target**:
What an adapter supplies so the conformance suite can run against it: how to construct a storage
and how to clean up afterwards. What that storage supports the suite reads from the storage.
_Avoid_: fixture, subject, adapter under test

**Harness**:
The code that runs the conformance cases on one runtime and reports them. Every runtime has its
own; the cases do not.
_Avoid_: runner, driver, wrapper

**Emulator**:
A server that speaks a provider's wire protocol without being the provider. The conformance suite
runs against one so that a change can be checked without a bucket, a provider-issued credential and
the cost of a real request.
_Avoid_: mock, fake, local S3

**Divergence**:
A named difference between what an emulator does and what the provider it stands in for does. It is
recorded against the conformance case it shows up in, and the same case run against the provider is
what settles it. A difference between two promised providers is not a divergence: nothing settles
it, and the spec carries it.
_Avoid_: known issue, quirk, accepted failure
