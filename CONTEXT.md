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

**Object**:
A sequence of bytes stored under a key, together with its content type and its metadata.
_Avoid_: file, blob, entry

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

**Parity core**:
The operations every adapter supports alike: `put`, `get`, `stat`, `list`, `delete`, `copy`. An
application that stays inside the parity core changes its adapter without changing its code.
_Avoid_: basic operations, common API, lowest common denominator

**Capability**:
Something an adapter offers beyond the parity core and declares, such as presigned URLs or
range reads. An adapter that lacks a capability says so rather than failing at call time.
_Avoid_: feature, feature flag, extension

**Reference flow**:
One of the five call sequences that v0.1 is designed to support, each of which names the adapters
and runtimes it covers and the conditions under which it counts as supported.
_Avoid_: use case, user story, scenario

**Conformance suite**:
Tests run against an adapter to show that it implements the API as specified.
_Avoid_: compliance tests, adapter test kit, acceptance tests
