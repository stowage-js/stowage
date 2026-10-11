# adapter-fs holds "absent" through a hard link, adapter-memory holds every precondition

ADR 0070 gave preconditions their shape and drew the capabilities so that a file system could hold
`writeIfAbsent` while no file system holds `writeIfUnchanged` or `deleteIfUnchanged`. ADR 0071
settled the cloud adapters. This records what `adapter-fs` and `adapter-memory` do (#442).

`adapter-fs` declares `writeIfAbsent` and neither of the other two. It reports no `etag`, and
nothing a file system offers compares a file against a token without a race between the check and
the write. It holds "absent" with `link(2)`: a `put` or `copy` carrying `onlyIf: "absent"` fills
its temporary file as every write does, then links it to the key's path and removes the temporary
name. `link` refuses with `EEXIST` when anything holds the name, atomically against every other
process, which `rename`, the step an unconditional write ends in, does not: it replaces what it
finds. A conditional `move` links the source to the destination and then removes the source.
`open` with `O_EXCL` on the key's path was the alternative. It reserves the name with an empty file
the bytes are then renamed over, so a reader sees an empty object while the body streams in and a
run that breaks leaves one behind, against spec 6's promise that no reader sees half of a write.
`renameat2` with `RENAME_NOREPLACE` and `renamex_np` with `RENAME_EXCL` do what is needed in one
step, and neither Node, Bun nor Deno exposes them. Writes without `onlyIf` keep ending in `rename`.

A conditional `move` puts the object under both keys between the link and the removal of the
source, the window `copy` followed by `delete` has on every cloud adapter. Spec 4.10 has a `move`
whose delete failed leave the destination in place; what a repeat of that `move` meets, its own
destination under `onlyIf: "absent"`, is a question for every adapter and stays with #443.

`link` resolves a symbolic link it is given as the source on macOS and does not on Linux, and none
of the runtimes offers `linkat` with a flag to choose. A conditional `move` of a key that holds a
link therefore links the file the link resolves to, which spec 6 already requires to lie below the
root, and then removes the link. The destination holds the same bytes on both systems, as a `copy`
of such a key already does through `copyFile`. An unconditional `move` keeps renaming the link
itself.

After `EEXIST`, the adapter looks at what holds the name. A file, or a link that resolves to a file
below the root, is an object, and the call is `PreconditionFailed`. Anything else is
`InvalidRequest`, as a write to a key that names a directory already is: a directory, a link that
resolves to nothing, or a link that leaves the root. Such a key answers `exists` with `false`, and
an unconditional `put` replaces the link, but replacing it only while it is still that link is no
step a file system offers. `PreconditionFailed` was the alternative, and it would send a caller
that reads the key back into `NotFound` and around again.

A file system without hard links, such as FAT, exFAT and some network mounts, refuses `link` with
`EPERM`, `ENOTSUP` or `EOPNOTSUPP`. On that one call those are `ProviderError` with
`retryable: false`, `providerCode` carrying the `errno` string and a message that the file system
holds no hard links, rather than the `AccessDenied` the `errno` mapping of spec 6 gives `EPERM`
elsewhere: the file is one the adapter just wrote, in a directory it just wrote to. `Unsupported`
naming `writeIfAbsent` was the alternative, and ADR 0070 reserves it for a capability the storage
does not declare, refused before anything is written. The declaration stays fixed per storage and
holds on the file systems the adapter runs on, which all have hard links.

`adapter-memory` declares all three. It checks the precondition in the same synchronous step that
stores the object, after the body is read and its `etag` computed, so no other call on the storage
runs between the check and the store. A conditional `delete` is one key and resolves with a
`DeleteReport` whose failed entry is `PreconditionFailed`, without `status` or `providerCode`, as
every failure of this adapter is. Its `etag` stays the SHA-256 of the bytes, so a rewrite of the
same bytes keeps it, which ADR 0070 left unpromised.

Neither adapter checks a precondition before it reads the body. A check in front would only save
the bytes of a write that is going to fail, and it holds nothing: another writer can take the key
right after it. `adapter-memory` is what a third-party adapter is read against (ADR 0008), and a
check in front there would read as a part of the guarantee. A refused precondition leaves the key
as it was: `adapter-fs` removes its temporary file and the directories the call created where they
stayed empty, as for any failed write, and a `move` refused at its destination leaves `from` in
place (ADR 0070).

Nothing here is a withdrawal, and nothing reaches spec 18: both adapters run in the suites on every
commit. Reference flow 5 does not change. A script moving from `fs` to a cloud provider sets its
precondition on the cloud target. A script moving the other way can pass `onlyIf: "absent"` to
`adapter-fs`, while an `onlyIf: { etag }` is `Unsupported` naming `writeIfUnchanged`.

## Consequences

- Spec 5 has `adapter-memory` declare `writeIfAbsent`, `writeIfUnchanged` and `deleteIfUnchanged`,
  and check a precondition in the step that stores the object.
- Spec 6 has `adapter-fs` declare `writeIfAbsent` alone, end a conditional `put` and `copy` in
  `link` rather than `rename`, and end a conditional `move` in `link` and the removal of the source,
  linking the file a link resolves to. It names the `InvalidRequest` for a name that holds no
  object, and the `ProviderError` for a file system without hard links in the `errno` mapping.
- A conditional `move` that is repeated after its delete failed goes to #443.
- Settled while writing the v0.7 spec (#447): reference flow 5 stays without a line on
  preconditions, as this decision has it. The README of `adapter-fs` names among its limits that
  `writeIfAbsent` needs a file system with hard links.
