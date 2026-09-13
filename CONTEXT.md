# stowage

stowage puts object storage providers behind one typed API, so that an application developed
against local disk runs against a cloud provider without a code change.

## Language

**Provider**:
The vendor or service that stores the bytes: Amazon S3, Cloudflare R2, Azure Blob, the local
file system.
_Avoid_: cloud, backend, service

**Adapter**:
An implementation of the storage API for one provider.
_Avoid_: driver, connector, client

**Storage**:
One adapter bound to one bucket, and the object an application holds. Another bucket is another
storage.
_Avoid_: disk, client, connection

**Wire protocol**:
The HTTP API a provider publishes, which an adapter implements directly rather than through
the provider's own SDK.
_Avoid_: protocol, transport, REST API

**Object**:
A sequence of bytes stored under a key, together with its content type and its metadata.
_Avoid_: file, blob, entry

**Stored object**:
What `get` hands back: the object's description together with its bytes, readable as a stream, as
bytes, as text or as JSON.
_Avoid_: handle, file, response

**Key**:
The full name an object is stored under. Keys are flat, and the API has no directories.
_Avoid_: path, filename, id

**Prefix**:
The leading part of a key. Listing by prefix with a delimiter yields the keys below it and the
next level of pseudo-directories.
_Avoid_: folder, directory, namespace

**Cursor**:
An opaque string naming the position a listing reached, which a later call hands back to
continue from there.
_Avoid_: token, continuation token, page marker

**Listing**:
What `list` returns. Iterated it yields every object and walks the pages itself; asked for a page
it performs one call and hands back that page with its cursor. A delimiter shapes a page, not the
iteration: the pseudo-directories it produces reach the caller through a page alone.
_Avoid_: iterator, result, page

**Parity core**:
The operations every adapter supports alike: `put`, `get`, `stat`, `exists`, `list`, `delete`,
`deleteAll`, `copy` and `move`. An application that stays inside the parity core changes its
adapter without changing its code.
_Avoid_: basic operations, common API, lowest common denominator

**Capability**:
Something an adapter offers beyond the parity core and declares, such as presigned URLs or
range reads. An adapter that lacks a capability says so rather than failing at call time.
_Avoid_: feature, feature flag, extension

**Runtime**:
The JavaScript engine and standard library the code runs on: Node, Bun, Deno, workerd.
_Avoid_: environment, platform, target

**Host**:
A service that runs code on a runtime, such as Deno Deploy, AWS Lambda or Cloudflare's network.
A host inherits what its runtime can do and adds limits of its own. stowage names runtimes, not
hosts.
_Avoid_: platform, provider, deployment target

**Reference flow**:
One of the five call sequences that v0.1 is designed to support, each of which names the adapters
and runtimes it covers and the conditions under which it counts as supported.
_Avoid_: use case, user story, scenario

**Runtime matrix**:
The grid of reference flows against runtimes that fixes what v0.1 promises. A cell counts as
supported only where the conformance suite covers it, and there is no weaker level below that.
_Avoid_: support matrix, compatibility table

**Conformance suite**:
Tests run against an adapter to show that it implements the API as specified.
_Avoid_: compliance tests, adapter test kit, acceptance tests
