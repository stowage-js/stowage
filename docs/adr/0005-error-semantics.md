# One error class, discriminated by a portable code

Every failure stowage reports is a `StorageError`, and callers branch on its `code` rather than on
its class. A hierarchy was the shape the concept sketch proposed, but `instanceof` compares
constructors, and two copies of `@stowage/core` in one dependency tree produce two constructors for
the same error. A package family makes that a normal outcome rather than a corner case: an
application can hold `@stowage/adapter-s3` resolved against one version of the core while its own
dependency resolves another. `isStorageError()` therefore tests a brand under
`Symbol.for("stowage.error")`, which survives that split, and the class has no subclasses, so there
is one way to ask what went wrong instead of two that disagree.

The codes name causes, not the operations that ran into them. `flydrive` names them after
operations — `E_CANNOT_READ_FILE` and twelve siblings — and so has no way to say that a key is
absent, while the operation is in the stack trace anyway and travels on the error as `operation`.
`StorageErrorCode` is closed, for the same reason the core interface is:

```ts
type StorageErrorCode =
  | "NotFound" | "AccessDenied" | "InvalidCredentials" | "Expired"
  | "InvalidRequest" | "NetworkError" | "ProviderError"
  | "InvalidKey" | "InvalidOption" | "Unsupported";
```

A code is portable in the sense that one condition carries one name in every adapter, not in the
sense that every adapter can produce every code: `adapter-fs` has no clock to be wrong about and
never reports `Expired`. `PreconditionFailed` is absent because the v0.1 surface has no conditional
headers, so nothing can raise it, and a code the conformance suite cannot exercise is a claim the
types make and the implementation does not keep. `InvalidCredentials` and `Expired` stay apart from
`AccessDenied` because S3 answers all three with `403` and only the first means the caller may not
do this; a wrong secret and a clock that has drifted are the caller's own bugs and are fixed in
different places.

The core owns the class, the union, the guard and the mapping from HTTP status, and each adapter
owns the table from its provider's codes. A recognized provider code decides alone. Failing that,
the status decides for the unambiguous ones — `404` is `NotFound`, `403` is `AccessDenied`, `401`
is `InvalidCredentials`, and `408`, `429` and `5xx` fall through — and anything left is
`ProviderError` with the raw string in `providerCode`. `CompleteMultipartUpload` is the one
response whose status decides nothing, because AWS documents that it can carry an error document
under `200`, so the adapter reads that body before it reads the status. The provider's own message
is passed through word for word:
`@tweedegolf/storage-abstraction` flattens every failure to `err.message` and drops the code, the
status and the request id, which are the three fields that make an S3 failure traceable at all. The
error carries `code`, `operation`, `key`, `bucket`, `provider`, `status`, `providerCode`,
`requestId`, `retryable`, `attempts`, `capability` and `cause`. `capability` names the capability
of ADR 0015 the adapter does not have and is set for `Unsupported` alone, so a conformance case can
tell the refusal it asked for from another one. `cause` always holds whatever was thrown
underneath, such as a `TypeError` from `fetch` or an `ENOENT` from Node.

What the parity core promises about absence is limited by `HEAD`, which carries no body. `get` reads
`NoSuchKey` from the error document and `stat` sees a bare `404`, so both report `NotFound` and v0.1
names no separate code for a missing bucket: a bucket that is not there is a configuration error
that shows up on the first call, and the provider's message says so. `exists` turns `NotFound` into
`false` and throws everything else, because a bucket the credentials cannot read would otherwise be
indistinguishable from an empty one. Deleting a key that is not there succeeds, since S3 answers
`204` either way and `adapter-fs` swallows `ENOENT` to match.

`delete` is best effort, not atomic. A per-key failure does not stop the other keys, and the
operation does not roll back keys the provider already accepted. It resolves with
`{ requested: number; failed: readonly StorageError[] }`: `requested` is the number of keys the
caller supplied, and each entry in `failed` carries the key it concerns. A failure of the operation
as a whole, such as invalid credentials, an unreachable provider or an inaccessible bucket,
rejects with the usual `StorageError` instead of returning a per-key report.

Abort is the one failure that is not a `StorageError`. An aborted `AbortSignal` produces the
runtime's `AbortError`, which `fetch` throws by itself and `signal.throwIfAborted()` gives the
adapters that do not call `fetch`. It is the caller's own action rather than a failure of the
storage, and every consumer already tests `err.name`. Everything stowage itself refuses is a
`StorageError`, including an invalid key, an unknown option and a capability the adapter does not
have. A `TypeError` would be the more idiomatic throw for a bad argument, but it has no `code`, and
a conformance suite that can only match on a message is the most fragile suite there is.

## Consequences

- Adding a code breaks a caller who switches exhaustively over `StorageErrorCode`. ADR 0017 leaves
  that switch outside the contract — a published code keeps its meaning, the list may grow — so a
  new code is a minor release.
- `stat` on a missing key cannot say whether the bucket exists, and `get` on the same key can. The
  conformance suite asserts the code, which both operations can keep, and not the detail below it.
- `exists` cannot answer `false` for a key it is not allowed to see. Under credentials narrow
  enough that S3 answers `403` for absent keys, it throws rather than reporting absence.
- A delete report identifies every per-key failure; subtracting `failed.length` from `requested`
  counts the keys the provider accepted, not the objects that were removed. No adapter can promise
  the second number, because S3 does not send it.
- An unknown key in an options object is `InvalidOption`, wherever it arrives: in the
  configuration a storage is constructed from and in the options of a single call. TypeScript's
  compile-time check refuses a misspelled `regoin` only where the object is written as a literal
  against the type. A configuration derived from JSON or widened before use bypasses that check,
  so every adapter validates options at runtime and rejects every unknown key with
  `InvalidOption`. The error names the key and never its value. The rule ends at the resolved
  credential, whose unknown key is `InvalidCredentials` for the reason ADR 0007 gives.
- Callers handle two shapes: `isStorageError()` for storage failures and `err.name === "AbortError"`
  for their own cancellation.
- A failure that arrives after the operation's promise resolved is wrapped as well — a body stream
  that breaks partway through `get`, a page that fails during a `list` iteration — so the form of
  the error does not depend on whether the caller took `stream()` or `bytes()`. Wrapping the stream
  handed to the caller costs one queue hop on the streaming download flow, which is worth measuring
  once there is something to measure.
- A compound operation throws the error of the step that failed and names the whole operation in
  `operation`. `move` leaves the destination in place when the delete fails, because deleting it
  could destroy an object the copy overwrote, and repeating the `move` from that state is safe.
- A multipart upload aborts itself on failure and on the caller's abort, which is the one request
  that cannot carry the signal that just fired. The exception is a `CompleteMultipartUpload` left
  without an answer, where a commit may still be travelling and ADR 0016 sends no abort. If an
  abort fails too, the parts stay and the provider charges for them, and v0.1 says so rather than
  working around it: the remedy is a lifecycle rule for incomplete uploads on the bucket.
- `retryable` states that the condition is transient, not that stowage will try again. An error can
  arrive with `retryable` set and its retries already spent, and a failure in a stream that cannot
  be replayed arrives without having been retried at all. `attempts` counts the requests that went
  out, so those two cases are told apart. Which codes are transient, and with what backoff, is ADR
  0013.
