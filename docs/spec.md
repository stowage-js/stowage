# stowage specification

This document states what the `@stowage/*` packages promise. A caller may rely on what it says and
on nothing else a package happens to export. It describes the version that is current on `main`;
the README of every published package links the revision that belongs to that release.

The terms used here are defined in [`CONTEXT.md`](../CONTEXT.md). The reasoning behind each rule is
in [`docs/adr/`](adr/), one decision per file; this document states the rules without repeating the
reasoning. Where a section names an ADR, that ADR holds the alternatives that were weighed.

## 1. Packages

| Package                       | Contents                                                        | Runtimes                   |
| ----------------------------- | --------------------------------------------------------------- | -------------------------- |
| `@stowage/core`               | The types of the parity core, `StorageError`, adapter utilities | Node, Bun, Deno, `workerd` |
| `@stowage/adapter-memory`     | A storage held in process memory                                | Node, Bun, Deno, `workerd` |
| `@stowage/adapter-fs`         | A storage rooted in one directory of the local file system      | Node, Bun, Deno            |
| `@stowage/adapter-s3`         | A storage in one bucket of AWS S3 or Cloudflare R2              | Node, Bun, Deno, `workerd` |
| `@stowage/adapter-azure-blob` | A storage in one container of an Azure Blob Storage account     | Node, Bun, Deno, `workerd` |
| `@stowage/conformance`        | The cases every adapter has to pass                             | Node, Bun, Deno, `workerd` |

- The six packages carry one version number and are released together (ADR 0008, ADR 0019).
- Every package is published as ESM only. No package has a runtime dependency outside `@stowage/*`
  (ADR 0003, ADR 0008, ADR 0019).
- Node's floor is 24, declared through `engines`. Bun and Deno have no floor; each README names the
  version CI last ran green. `workerd` runs with the compatibility date `2026-09-01` and the flags
  `no_nodejs_compat` and `no_nodejs_compat_v2`, which the `workerd` harness pins as well; no package
  needs a Node API there (ADR 0002). Every `workerd` cell holds under the default flags of that
  date as well, which turn `nodejs_compat` on.
- Nothing detects the runtime at import time. A runtime not listed above is neither blocked nor
  supported.
- The tarballs hold `dist/`, `LICENSE` and the README. This document is not in them.
- Nothing is published under the bare name `stowage`.

## 2. Runtime matrix

A cell is supported where the conformance suite covers it in CI. There is no weaker level (ADR
0002).

|                                                          | Node                               | Bun                                | Deno                               | `workerd`                    |
| -------------------------------------------------------- | ---------------------------------- | ---------------------------------- | ---------------------------------- | ---------------------------- |
| 1 large upload from a server                             | yes                                | yes                                | yes                                | yes                          |
| 2 browser upload through a presigned `PUT`               | yes                                | yes                                | yes                                | yes                          |
| 3 file browser listing one prefix                        | yes                                | yes                                | yes                                | yes                          |
| 4 streaming download from an edge runtime                | yes                                | yes                                | yes                                | yes                          |
| 5 move a prefix from the file system to a cloud provider | yes                                | yes                                | yes                                | no                           |
| adapters covered in CI                                   | `memory`, `fs`, `s3`, `azure-blob` | `memory`, `fs`, `s3`, `azure-blob` | `memory`, `fs`, `s3`, `azure-blob` | `memory`, `s3`, `azure-blob` |

- CI runs Node 24 and Node 26.
- The `fast` tier of the conformance suite runs on every pull request against SeaweedFS for
  `adapter-s3` and against Azurite for `adapter-azure-blob`, each pinned by image digest. The
  `slow` tier runs on a schedule, on demand and before every release; on Node and `workerd` it
  runs against a real AWS S3 bucket, a real R2 bucket and a real Azure Blob Storage account, on Bun
  and Deno against the emulators (ADR 0012, ADR 0023, ADR 0026).
- On `workerd` the whole suite runs under `no_nodejs_compat` and `no_nodejs_compat_v2`, and the
  `fast` tier runs a second time under the date's default flags.
- Hosts such as Cloudflare's network, Deno Deploy or AWS Lambda are not named in the matrix and
  not promised.
- Flow 1 on `workerd` is promised for the runtime and on no host. The first scheduled run measured
  a 17 MiB upload to S3 at about five seconds and under a second of CPU for the whole `workerd`
  process, which Cloudflare's paid plans allow by default and its free plan's 10 milliseconds do
  not. The same upload to Azure Blob is measured by the first scheduled run against the account
  (section 13).

## 3. Reference flows

The five call sequences stowage is designed for. Each names its adapters and runtimes, what has to
hold for it to count as supported, and the failures it has to tell apart. The conformance suite
carries one case per flow (section 9.6).

### Flow 1: large upload from a server

A server process writes a stream of unknown length under a key.

- In: key, `ReadableStream<Uint8Array>`, optional content type and user metadata.
- Out: the stored object's description.
- Adapters: `memory`, `fs`, `s3`, `azure-blob`. Runtimes: Node, Bun, Deno, `workerd`.
- Holds when: memory does not grow with the size of the object (`adapter-memory` excepted); the
  object reads back byte for byte; after an upload that fails partway or is aborted, the key is
  absent or holds what it held before. What such an upload leaves with the provider is stated per
  adapter: nothing on S3 except in the one case section 7.7 names (section 7.6), its staged blocks
  on Azure Blob (section 8.6).
- Fails as: the caller aborts (`AbortError`); the credential expires during the upload (`Expired`,
  or `InvalidCredentials` where the adapter cannot tell an expiry, section 8.3); the provider
  rejects the write (`AccessDenied`, `InvalidRequest`, `ProviderError`).

### Flow 2: browser upload through a presigned `PUT`

A server signs a URL and the browser uploads to the provider directly.

- In: key, lifetime, content type, and the content length the client reported.
- Out: a URL and the headers a plain `fetch` sends with `PUT` beside the body.
- Adapters: `s3`, `azure-blob`. Runtimes: the signing side on Node, Bun, Deno and `workerd`.
- Holds when: content type and content length are bound through signed headers, so the provider
  rejects an upload that deviates from either; the binding is exact, and a body of unknown length
  cannot be uploaded through the URL; an expired URL is rejected; the rejections reach the client as
  an HTTP status.
- Fails as: signature mismatch, expired URL, a body that contradicts the signed headers. The
  provider answers the browser, so none of them reaches the adapter or becomes a `StorageError`.
- Requires, on `s3`: the bucket policy allows `UNSIGNED-PAYLOAD`, and CORS is configured for the
  origin that uploads. On `azure-blob`: the account's CORS rule allows the origin, `PUT`, and the
  headers `content-type` and `x-ms-blob-type`, and the signing storage is built with an access
  token (section 8.9). stowage states these and configures none of them.
- Every cross-origin upload through the URL is preflighted, because `PUT` is not a CORS-safelisted
  method. Azure Blob answers a rejected upload with the CORS headers of the rule, so a page reads
  its status and not its `x-ms-error-code`; R2 sends none on the `403` for an expired URL, so a
  page sees a network error there.
- Carries no integrity check: neither provider signs a hash or a checksum of the body into the
  URL.

### Flow 3: file browser listing one prefix

An HTTP handler serves one page of a directory view.

- In: prefix, delimiter `/`, page size, optional cursor.
- Out: objects at that level, the pseudo-directories one level down, and the next cursor.
- Adapters: all. Runtimes: all four.
- Holds when: a prefix holding more than 1000 objects lists completely across pages; keys below
  the delimiter appear as prefixes and not as objects; the cursor is a string that a fresh process
  hands to a new listing to continue.
- Fails as: an invalid cursor (`InvalidOption`). A prefix that holds nothing is an empty page, not a
  failure.

### Flow 4: streaming download from an edge runtime

A worker answers a client `GET` and passes the client's `Range` on to the provider.

- In: key, optional byte range.
- Out: a `ReadableStream<Uint8Array>`, the content type for the response header, and for a range
  the partial content.
- Adapters: `s3`, `azure-blob`. Runtimes: all four.
- Holds when: nothing is buffered, so memory stays flat for an object of any size; a range returns
  partial content; the client disconnecting cancels the stream and reaches the provider.
- Fails as: missing key (`NotFound`); range not satisfiable (`InvalidRequest`).

### Flow 5: move a prefix from the file system to a cloud provider

A one-off script moves everything below a prefix to another provider.

- In: source storage and prefix, target storage and prefix.
- Out: what moved, and the failures per object.
- Adapters: `fs` to `s3` or `azure-blob`, and any other pair. Runtimes: Node, Bun, Deno.
- Holds when: the stream out of `get` goes into `put` without the object being held whole anywhere;
  the content type survives the move where the target stores one (section 6 for where `adapter-fs`
  does not); `deleteAll(prefix)` pages and batches on its own and reports what it could not delete.
- Fails as: the run fails partway; a source object disappears during the run (`NotFound`); the target
  rejects a write.

Copying between two storages is not an operation of the API. The API owes that the stream out of
`get` is accepted by `put` unchanged; the loop is the caller's.

## 4. The core API: `@stowage/core`

`@stowage/core` does nothing on its own. It publishes the types every adapter implements, the error
every adapter throws, and the utilities an adapter calls. An application that writes against
`Storage` is portable across adapters and cannot reach a provider option; reaching one means naming
the concrete adapter type at the call site (ADR 0004).

### 4.1 `Storage`

```ts
export interface Storage {
  readonly provider: string;
  readonly bucket: string;
  readonly capabilities: readonly CapabilityName[];

  put(key: string, body: PutBody, options?: PutOptions): Promise<ObjectStat>;
  get(key: string, options?: GetOptions): Promise<StoredObject>;
  stat(key: string, options?: OperationOptions): Promise<ObjectStat>;
  exists(key: string, options?: OperationOptions): Promise<boolean>;
  list(options?: ListOptions): ObjectListing;
  delete(...keys: readonly string[]): Promise<DeleteReport>;
  deleteAll(prefix: string, options?: OperationOptions): Promise<DeleteReport>;
  copy(from: string, to: string, options?: OperationOptions): Promise<ObjectStat>;
  move(from: string, to: string, options?: OperationOptions): Promise<ObjectStat>;
}
```

- The interface is closed: no generic parameter, no index signature, no registry. An adapter
  extends it and may add methods and widen option types on its own concrete type; it may not
  narrow what the interface accepts.
- `provider` names the adapter: `"memory"`, `"fs"`, `"s3"` or `"azure-blob"`. `bucket` names the
  namespace the storage is bound to (sections 5 to 8 say what that is per adapter).
- `capabilities` lists every capability the storage implements, each once, out of
  `capabilityNames`. It is fixed when the storage is constructed.
- Every operation is asynchronous and rejects rather than throwing synchronously, including for an
  invalid argument.
- Every operation except `delete` takes an `AbortSignal` through its options. `delete` is variadic
  and has no room for one; it sends its keys in batches, one request per batch, and each adapter
  states its batch size (ADR 0020).
- There is no facade, no manager over several storages, no clone onto another bucket, and no bucket
  management. Another bucket is another storage.

### 4.2 Bodies

```ts
export type PutBody = Uint8Array | string | ReadableStream<Uint8Array>;
```

- A string is stored as its UTF-8 bytes.
- A stream is read once. After `put` resolves or rejects, the stream is at its end or canceled.
- No other type is accepted; a `Blob` is passed as `blob.stream()`, an `ArrayBuffer` as
  `new Uint8Array(buffer)`.
- The type of the body decides how an adapter sends it: bytes it holds may go as one request, a
  stream is sent in parts once it fills more than one (sections 7.6 and 8.6 for the numbers). No
  adapter hands `fetch` a body stream of unknown length.

### 4.3 Options

```ts
export interface OperationOptions {
  signal?: AbortSignal;
}

export interface PutOptions extends OperationOptions {
  contentType?: string;
  userMetadata?: Record<string, string>;
}

export interface GetOptions extends OperationOptions {
  range?: ByteRange;
}

/** Both ends inclusive; `end` absent means to the end of the object. */
export interface ByteRange {
  start: number;
  end?: number;
}

export interface ListOptions extends OperationOptions {
  prefix?: string;
  delimiter?: string;
  pageSize?: number;
  cursor?: string;
}
```

- An option key that is not listed here or on the concrete adapter type is `InvalidOption`,
  whether it arrives in a call or in the configuration a storage is constructed from. The error
  names the key and never its value.
- `contentType` absent: `adapter-memory`, `adapter-s3` and `adapter-azure-blob` store
  `application/octet-stream`; `adapter-fs` derives the type from the key (section 6).
- `userMetadata` is stored where the storage declares `userMetadata`. Keys are compared
  case-insensitively. Values may hold any Unicode; a value that would not travel in a header as
  written is RFC 2047-encoded. A `userMetadata` with at least one entry is checked in this order,
  each before signing and with `attempts: 0`:
  1. Where the storage does not declare `userMetadata`, it is `Unsupported` naming `userMetadata`.
     `undefined` and `{}` pass on every storage.
  2. A key that is not a non-empty ASCII HTTP token, including one holding a space, control,
     colon, slash, question mark or bracket, is `InvalidRequest`.
  3. Keys and values together hold at most 2 KB, measured as the header bytes the encoding of
     section 4.13 produces, whatever an adapter encodes beyond it; more is `InvalidRequest`.
  4. Where the storage does not declare `userMetadataTokenKeys`, a key that is not an ASCII
     identifier, `[A-Za-z_][A-Za-z0-9_]*`, such as `content-hash`, `x.y` or `1st`, is
     `Unsupported` naming `userMetadataTokenKeys` (ADR 0020).
- `range` is honored where the storage declares `rangeReads` and is `Unsupported` elsewhere. `start`
  and `end` are non-negative integers with `start <= end`; anything else is `InvalidOption`. A
  `start` at or beyond the object's size is `InvalidRequest`. An `end` beyond the size is clipped.
- `pageSize` takes 1 to 1000 and defaults to 1000; outside that range it is `InvalidOption`. A
  `cursor` the storage did not produce is `InvalidOption` naming `cursor`.
- `signal` already aborted rejects before any request. Aborting during an operation cancels what
  is in flight and rejects with the runtime's `AbortError`, which is not a `StorageError`.

### 4.4 Object descriptions

```ts
export interface ObjectEntry {
  readonly key: string;
  readonly size: number;
  readonly lastModified: Date;
  readonly etag?: string;
}

export interface ObjectStat extends ObjectEntry {
  readonly contentType: string;
  readonly userMetadata: Readonly<Record<string, string>>;
}
```

- `put`, `stat`, `copy`, `move` and `get` produce an `ObjectStat`. A listing yields `ObjectEntry`,
  because a listing response carries neither content type nor metadata.
- `size` counts bytes. After `put` it is the number of bytes written; after a ranged `get` it is
  the size of the whole object, not of the range.
- `lastModified` after `put`, `copy` and `move` is the time the provider reported when it accepted
  the object; a later `stat` may differ from it by the provider's rounding, one second on S3.
- `etag` is set where the provider sends one. `adapter-fs` sends none. Its value is opaque and is
  not promised to be an MD5.
- `userMetadata` is an object on every adapter, empty where the storage holds none or does not
  declare the capability.

### 4.5 Stored objects

```ts
export interface StoredObject {
  readonly stat: ObjectStat;
  stream(): ReadableStream<Uint8Array>;
  bytes(): Promise<Uint8Array>;
  text(): Promise<string>;
  json<T = unknown>(): Promise<T>;
}
```

- `stat` comes from the same response as the body; `get` costs one round trip.
- The body is read once. A second call to any of the four readers rejects with `InvalidRequest`.
- `text()` decodes UTF-8. `json()` parses the text; a parse failure rejects with the runtime's
  `SyntaxError`, which is not a `StorageError`.
- A body stream that breaks after `get` resolved errors with a `StorageError`, whichever reader
  was taken. It is not resumed.
- Canceling the stream cancels the request behind it.

### 4.6 Listings

```ts
export interface ObjectListing extends AsyncIterable<ObjectEntry> {
  page(): Promise<ListPage>;
}

export interface ListPage {
  readonly objects: readonly ObjectEntry[];
  readonly prefixes: readonly string[];
  readonly cursor?: string;
}
```

- `list` performs no request until the listing is iterated or `page()` is called.
- Iterated, the listing yields every object below the prefix once, walking pages on its own. With
  a `delimiter`, it yields the objects at that level only; the pseudo-directories reach the caller
  through `page()` alone.
- `page()` performs one call and returns at most `pageSize` objects with the `cursor` that continues
  from there. An absent `cursor` means the listing is complete. A cursor is opaque and may be handed
  to a new `list` call in another process.
- `prefixes` holds each pseudo-directory one level below the prefix once, ending in the delimiter.
- Order is not promised. A caller who needs order sorts after collecting every page.
- Keys written by other tools appear as they are, including keys ending in `/` and keys longer than
  a writable key may be; `get`, `stat`, `exists`, `delete` and the source of `copy` accept them.
- A listing entry that arrives without a key, a size or a last-modified time is `ProviderError`.

### 4.7 Delete reports

```ts
export interface DeleteReport {
  readonly requested: number;
  readonly failed: readonly StorageError[];
}
```

- `requested` is the number of keys the call covered. `requested - failed.length` is the number of
  keys the provider accepted, not the number of objects removed: deleting an absent key succeeds.
- Each entry in `failed` carries the key it concerns. An invalid key is reported there with
  `InvalidKey` rather than rejecting the call, so the other keys are still deleted.
- A failure of the request as a whole, such as a credential the provider refuses or an unreachable
  provider, rejects the call instead of filling the report.
- A per-key failure is not retried by the adapter. Its entry carries `retryable`; deleting is
  idempotent, so the caller may repeat it.

### 4.8 Keys

Every key is a string of Unicode characters measured in UTF-8 bytes. The core validates a key
before an adapter sends a request and never rewrites it. Which rule applies depends on whether
stowage creates the key or only names one (ADR 0010).

| Rule          | Applies to                                                                       | Requirements                                                                                                                                                                |
| ------------- | -------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `writable`    | `put`, the `to` of `copy` and `move`, `presignPut`                               | 1 to 1024 bytes; no `.` or `..` as a segment; no leading `/`; no empty segment (`//`); no trailing `/`; no backslash; no character in `U+0000` to `U+001F` and no `U+007F`  |
| `addressable` | `get`, `stat`, `exists`, `delete`, the `from` of `copy` and `move`, `presignGet` | At least 1 byte; no `.` or `..` as a segment; no leading `/`; no empty segment; no control character. A trailing `/`, a backslash and a length above 1024 bytes are allowed |
| `prefix`      | `list`, `deleteAll`                                                              | The `addressable` rule, except that it may be empty, may end in `/`, and may end in the middle of a segment                                                                 |

- There is no allowlist. `#`, `%`, `?`, `+`, a space, `'` and every character above ASCII are legal.
  An adapter encodes a key itself and never builds a request path through the `URL` constructor.
- Nothing normalizes the Unicode form. Two keys that are equivalent under Unicode without being
  equal byte for byte may name one object or two, depending on the provider. A storage that
  declares `keyBytesPreserved` returns every key byte for byte as it was written; the others
  return a Unicode-equivalent key.
- An adapter may refuse more than the rule above and reports that as `InvalidKey` too; `adapter-fs`
  refuses a segment longer than 255 bytes, `adapter-azure-blob` three kinds of writable key
  (section 8.1). `adapter-memory` enforces the rule exactly.
- A violation is `InvalidKey` with `attempts: 0`. `copy` and `move` check both keys before acting
  on either. `delete` reports an invalid key in `failed`.
- An empty prefix on `deleteAll` deletes every object in the storage.

### 4.9 Capabilities

```ts
export const capabilityNames = [
  "keyBytesPreserved",
  "presignedUrls",
  "rangeReads",
  "userMetadata",
  "userMetadataTokenKeys",
] as const;

export type CapabilityName = (typeof capabilityNames)[number];
```

| Capability              | Where declared                                                                                      | Where not declared                                                                                                      |
| ----------------------- | --------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------- |
| `keyBytesPreserved`     | A key comes back byte for byte as written                                                           | A key comes back Unicode-equivalent                                                                                     |
| `presignedUrls`         | The concrete type carries `presignGet` and `presignPut`                                             | Neither method exists on the type                                                                                       |
| `rangeReads`            | `get` honors `range`                                                                                | `get` with `range` is `Unsupported`                                                                                     |
| `userMetadata`          | `put` stores `userMetadata` with ASCII identifier keys; `stat` and `get` return it; `copy` keeps it | `put` with a non-empty `userMetadata` is `Unsupported`; reads return `{}`                                               |
| `userMetadataTokenKeys` | Beside `userMetadata`: a key may be any ASCII HTTP token, such as `content-hash`                    | A key outside identifiers is `Unsupported` naming it; without `userMetadata` too, the call is `Unsupported` naming that |

- The declarations: `adapter-s3` `presignedUrls`, `rangeReads`, `userMetadata`,
  `userMetadataTokenKeys`; `adapter-azure-blob` `presignedUrls`, `rangeReads`, `userMetadata`;
  `adapter-fs` `rangeReads`; `adapter-memory` `keyBytesPreserved`, `rangeReads`, `userMetadata`,
  `userMetadataTokenKeys`.
- The declaration is runtime only. There is no type parameter over it.
- An `Unsupported` error names the capability in its `capability` field.
- The list is closed and grows in minor releases (section 10).

### 4.10 Errors

```ts
export type StorageErrorCode =
  | "NotFound"
  | "AccessDenied"
  | "InvalidCredentials"
  | "Expired"
  | "InvalidRequest"
  | "NetworkError"
  | "ProviderError"
  | "InvalidKey"
  | "InvalidOption"
  | "Unsupported";

export class StorageError extends Error {
  readonly code: StorageErrorCode;
  readonly operation: string;
  readonly key?: string;
  readonly bucket: string;
  readonly provider: string;
  readonly status?: number;
  readonly providerCode?: string;
  readonly requestId?: string;
  readonly retryable: boolean;
  readonly attempts: number;
  readonly capability?: CapabilityName;
  readonly cause?: unknown;
  constructor(fields: StorageErrorFields);
}

export function isStorageError(value: unknown): value is StorageError;
```

Every failure stowage reports is a `StorageError`. There are no subclasses; callers branch on
`code`. `isStorageError` tests a brand under `Symbol.for("stowage.error")` and holds across two
copies of `@stowage/core` in one dependency tree, where `instanceof` does not (ADR 0005).

| Code                 | Meaning                                                                                                                                                                                                                                       |
| -------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `NotFound`           | No object under the key, or no bucket. `stat` on S3 cannot tell the two apart, so one code names both                                                                                                                                         |
| `AccessDenied`       | The credential is valid and may not do this                                                                                                                                                                                                   |
| `InvalidCredentials` | The provider does not accept the credential, or a required credential field is empty or unknown                                                                                                                                               |
| `Expired`            | The credential or session token has expired                                                                                                                                                                                                   |
| `InvalidRequest`     | The provider or stowage refused the request for what it asked: metadata over the limit, an unsatisfiable range, a copy onto itself, a second read of a body, a request timestamp the provider refused where it names that apart (section 8.8) |
| `NetworkError`       | The request received no response: DNS, connection, TLS, a broken connection                                                                                                                                                                   |
| `ProviderError`      | The provider answered with a failure stowage has no other name for; `providerCode` carries its string                                                                                                                                         |
| `InvalidKey`         | The key violates the rule of section 4.8, or a rule the adapter adds to it                                                                                                                                                                    |
| `InvalidOption`      | An option or configuration value stowage refused: an unknown key, a value out of range, a cursor it did not produce                                                                                                                           |
| `Unsupported`        | The call needs a capability the storage does not declare; `capability` names it                                                                                                                                                               |

- `operation` names the operation the caller invoked, also for a failure inside a compound
  operation such as `move`. `key` is set where the failure concerns one key. `bucket` and
  `provider` repeat the storage's fields.
- `status`, `providerCode` and `requestId` are set where the provider answered. `providerCode` is
  the provider's own string, such as `NoSuchKey`, or the `errno` code of `adapter-fs`, such as
  `EACCES`. A caller never matches on it.
- `message` is the provider's message word for word where there is one.
- `retryable` states that the condition is transient. It says nothing about whether stowage sent
  the request again.
- `attempts` counts how often the failing step was attempted: `0` when stowage refused before the
  first attempt, `1` when a single attempt failed, more where the adapter repeated it.
- `capability` is set for `Unsupported` alone.
- `cause` holds what was thrown underneath, such as the `TypeError` from `fetch` or Node's `ENOENT`
  error.

**Mapping from an HTTP status.** An adapter maps a recognized provider code first (sections 7.9
and 8.8).
Where none is recognized, the status decides: `401` is `InvalidCredentials`, `403` is
`AccessDenied`, `404` is `NotFound`. `408`, `429` and every `5xx` are `ProviderError` with
`retryable: true`. Any other status is `ProviderError` with `retryable: false`.

**Absence.** `get` and `stat` on a missing key reject with `NotFound`. `exists` answers `false` for
`NotFound` alone and rethrows every other failure, including the `403` that S3 answers for a
missing key under a credential without `s3:ListBucket`. Deleting a missing key succeeds.

**Abort.** A fired `AbortSignal` produces the runtime's `AbortError`, never a `StorageError`.
Callers handle two shapes: `isStorageError(err)` and `err.name === "AbortError"`.

**After the promise resolved.** A body stream that breaks partway through `get` and a page that
fails during a `list` iteration arrive as `StorageError` as well.

**Compound operations.** `move` throws the error of the step that failed. When the delete fails,
the destination stays in place and repeating the `move` is safe.

### 4.11 Operations

| Operation   | Key rule                              | Does                                                                                                                                                 | Rejects with                                                                      |
| ----------- | ------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------- |
| `put`       | `writable`                            | Stores the body under the key, replacing any object there. Resolves once the object is readable under the key                                        | `InvalidKey`, `InvalidOption`, `InvalidRequest`, `Unsupported`, provider failures |
| `get`       | `addressable`                         | Returns the object's description and a body readable once                                                                                            | `NotFound`, `Unsupported` (range), `InvalidRequest` (range)                       |
| `stat`      | `addressable`                         | Returns the object's description without its body                                                                                                    | `NotFound`                                                                        |
| `exists`    | `addressable`                         | `true` where `stat` would succeed, `false` where it would reject with `NotFound`                                                                     | Every other failure `stat` would reject with                                      |
| `list`      | `prefix`                              | Section 4.6                                                                                                                                          | `InvalidOption` (`pageSize`, `cursor`, `delimiter`)                               |
| `delete`    | `addressable` per key                 | Deletes the keys, batching as the provider requires, in no promised order. Zero keys resolves with `requested: 0`                                    | A failure of the request as a whole                                               |
| `deleteAll` | `prefix`                              | Lists every object below the prefix and deletes it, paging and batching on its own. Objects written during the call may or may not be deleted        | A failure of the request as a whole                                               |
| `copy`      | `from` `addressable`, `to` `writable` | Creates `to` with the bytes, content type and user metadata of `from`, replacing any object at `to`. `from` stays. `from === to` is `InvalidRequest` | `NotFound`, `InvalidKey`, `InvalidRequest`                                        |
| `move`      | `from` `addressable`, `to` `writable` | `copy` then `delete` of `from`. Resolves with the description of `to`                                                                                | The failure of the step that failed                                               |

- `delimiter` is one or more characters; an empty string is `InvalidOption`.
- Nothing in the API is atomic across keys, and no operation is conditional. Of two writers to one
  key, each may resolve or reject, and the key ends with one whole object written by one of them
  (ADR 0024). `adapter-memory`, `adapter-fs` and `adapter-s3` resolve both.

### 4.12 Credentials

```ts
export type ResolverOptions = { forceRefresh: boolean };
export type Resolvable<T> = T | ((options?: ResolverOptions) => T | Promise<T>);
```

The pattern an adapter uses to take a credential: a value, or a function that yields one. The core
prescribes nothing about the credential's shape; each adapter's concrete type does. No core
signature mentions `Resolvable`.

### 4.13 Exports for adapter authors

```ts
export type KeyRule = "writable" | "addressable" | "prefix";
/** The reason a key violates the rule, or `undefined` where it holds. */
export function invalidKeyReason(key: string, rule: KeyRule): string | undefined;

/** The code the status decides on its own, or `undefined` for a status that decides nothing. */
export function errorCodeForStatus(status: number): StorageErrorCode | undefined;
export function isTransientStatus(status: number): boolean;

export interface RetryOptions {
  readonly maxAttempts: number;
  readonly signal?: AbortSignal;
}
/**
 * Repeats `attempt` while it rejects with a `StorageError` whose `retryable` is `true`, up to
 * `maxAttempts` times, waiting a random delay between zero and `min(5 s, 100 ms × 2^n)` before
 * attempt `n + 1`. The error it finally rejects with carries the number of attempts made.
 */
export function withRetry<T>(attempt: () => Promise<T>, options: RetryOptions): Promise<T>;

export interface XmlElement {
  readonly name: string;
  readonly attributes: Readonly<Record<string, string>>;
  readonly children: readonly XmlElement[];
  /** The text directly inside the element, its children's left out. */
  readonly text: string;
}
/** A document outside the subset `parseXml` reads. */
export class XmlSyntaxError extends Error {}
/** The root element of an answer document. */
export function parseXml(document: string): XmlElement;

/** The variable read through `process.env`, or `""` where it is unset or cannot be read. */
export function readEnvironment(name: string): string;

export type UserMetadataKeyRule = "token" | "identifier";
export function isUserMetadataKey(name: string, rule: UserMetadataKeyRule): boolean;
/** The value as a header carries it: as written where it travels so, else as encoded words. */
export function encodeUserMetadataValue(value: string, options?: { always?: boolean }): string;
/** A header value read back, with every form of encoded word RFC 2047 allows decoded. */
export function decodeUserMetadataValue(value: string): string;
/** What section 4.3 bounds at 2 KB: every key and its value as `encodeUserMetadataValue` writes it. */
export function userMetadataByteLength(userMetadata: Readonly<Record<string, string>>): number;

export interface PresignedPut {
  readonly url: string;
  /** The headers the client sends beside the body. `Content-Length` is never among them. */
  readonly headers: Readonly<Record<string, string>>;
}
```

- Every adapter calls `invalidKeyReason` as the first act of every operation and rejects with
  `InvalidKey` where it returns a reason.
- `errorCodeForStatus` and `isTransientStatus` are the one definition of the status mapping in
  section 4.10. `withRetry` is the one definition of the retry loop of sections 7.5 and 8.5;
  `adapter-fs` and `adapter-memory` do not call it.
- A `StorageError` with code `Unsupported` requires `capability`; the constructor rejects one
  without it.
- What two adapters need on the wire is defined here once; what one adapter alone needs stays in
  that adapter, the signers among it (ADR 0019).
- `parseXml` reads elements, attributes, text, comments, the five named entities and a numeric
  character reference to any Unicode scalar value except `U+0000`, under one optional declaration.
  CDATA, a DTD, a reference to `U+0000`, to a surrogate or above `U+10FFFF`, and anything else
  outside that subset are `XmlSyntaxError`, which an adapter reports as `ProviderError`. Accepting a
  reference to `U+FFFE` or `U+FFFF` departs from XML 1.0 on purpose (ADR 0027).
- `readEnvironment` reads one name at a time. A runtime without `process`, and a read the runtime
  refuses, such as Deno's without `--allow-env`, answer `""` rather than throwing (ADR 0021).
- `encodeUserMetadataValue` leaves a value as written where it is printable ASCII with no space at
  either end and no `=?`, and writes it as UTF-8 base64 encoded words of RFC 2047 otherwise, or with
  `always: true`. `userMetadataByteLength` measures without `always`, so the 2 KB of section 4.3 do
  not depend on what an adapter encodes beyond the rule.
- `PresignedPut` is what `presignPut` returns on every adapter that declares `presignedUrls`, so the
  code that uploads through it never names the provider (ADR 0022).

## 5. `@stowage/adapter-memory`

```ts
export interface MemoryStorage extends Storage {
  readonly provider: "memory";
}
export function memoryStorage(): MemoryStorage;
```

- `bucket` is `"memory"`. Two calls to `memoryStorage()` are two storages that share nothing.
- Declares `keyBytesPreserved`, `rangeReads`, `userMetadata` and `userMetadataTokenKeys`.
- Holds every object whole in memory and copies bytes on `put` and `get`, so a caller cannot change
  a stored object through the array it passed or received. It has no size limit of its own.
- Enforces the key rule of section 4.8 exactly, neither more nor less.
- `etag` is set to a hex SHA-256 of the bytes, so a caller can rely on it changing when the bytes
  do.
- Has no transient condition and never sets `retryable`. Reports no `status`, no `providerCode` and
  no `requestId`.
- Is the implementation a third-party adapter is read against. The cases of the conformance suite
  are written against the behavior of S3, not against this adapter.

## 6. `@stowage/adapter-fs`

```ts
export interface FsAdapterOptions {
  root: string;
}
export interface FsStorage extends Storage {
  readonly provider: "fs";
}
export function fsStorage(options: FsAdapterOptions): FsStorage;
```

- `bucket` is the `root` as given. `root` is an absolute path to an existing directory; construction
  performs no I/O, and an operation against a root that does not exist rejects with `NotFound`.
- Declares `rangeReads` only. `put` with a non-empty `userMetadata` is `Unsupported`; reads return
  `{}`.
- A key maps to the path below the root with `/` as the separator. Every access resolves the real
  path and answers `NotFound` where it lies outside the root, so a symbolic link pointing out of the
  root behaves as an absent object.
- Refuses a segment longer than 255 bytes with `InvalidKey`. A key whose whole path passes what the
  file system holds is `InvalidKey` as well, through the `ENAMETOOLONG` of the mapping below: macOS
  bounds one path at 1024 bytes with the root counted in, so the 1024-byte key of section 9.7 is
  written on Linux and refused there.
- The content type is derived from the key's extension through a built-in table, and
  `application/octet-stream` where the extension is unknown or absent. The `contentType` handed to
  `put` is validated as a string and not stored, so `stat` may report a type that differs from the
  one given to `put`. The parity core's promise that an object carries a content type is kept
  weakly here; `keyBytesPreserved` is the model, and no capability name exists for it.
- `put` writes to a temporary file in the same directory and renames it into place, so a reader sees
  the old object or the new one and never a partial write. Intermediate directories are created.
  That file carries a name of the adapter's own, which a listing passes over: a write in flight is
  no object, and neither is a key of that shape.
  `delete`, `deleteAll` and `move` remove directories left empty, up to the root, so a listing with a
  delimiter shows no empty pseudo-directory.
- `lastModified` is the file's modification time. `size` is the file's size. `etag` is not set.
- A key that names a directory, and a key whose parent path is a regular file, are `NotFound` on
  read and `InvalidRequest` on write.
- The Unicode form of a key survives a round trip except where the file system normalizes names,
  which APFS does not: it holds a name in the form it was written in. A file system may still fold
  the forms when it looks a name up, as APFS does, so that the decomposed key reaches the object
  the composed one wrote, and a case-insensitive file system collides keys that differ in case
  alone. Nothing repairs either.
- Runs on Node, Bun and Deno, on Linux and macOS. Windows is not named and not promised.
- `errno` mapping: `ENOENT` is `NotFound`; `EISDIR` and `ENOTDIR` are `NotFound` on read and
  `InvalidRequest` on write; `EACCES` and `EPERM` are `AccessDenied`; `ENAMETOOLONG` is `InvalidKey`;
  `EMFILE`, `EBUSY` and `EAGAIN` are `ProviderError` with `retryable: true`; everything else is
  `ProviderError` with `retryable: false`. `providerCode` carries the `errno` string. The adapter
  retries nothing itself.

## 7. `@stowage/adapter-s3`

### 7.1 Construction

```ts
export interface S3Credentials {
  accessKeyId: string;
  secretAccessKey: string;
  sessionToken?: string;
}

export interface S3AdapterOptions {
  bucket: string;
  region: string;
  endpoint?: string;
  forcePathStyle?: boolean;
  credentials: Resolvable<S3Credentials>;
  retry?: false | { maxAttempts?: number };
  multipart?: { partSize?: number; concurrency?: number };
}

export interface S3Storage extends Storage {
  readonly provider: "s3";
  presignGet(key: string, options: S3PresignGetOptions): Promise<string>;
  presignPut(key: string, options: S3PresignPutOptions): Promise<PresignedPut>;
}

export function s3Storage(options: S3AdapterOptions): S3Storage;
export function fromEnv(options?: ResolverOptions): S3Credentials;
```

- `bucket` is the S3 bucket. `region` is sent as configured; nothing discovers it. A `301` answer
  rejects with `InvalidOption` naming `region` and the region from `x-amz-bucket-region`.
- `endpoint` absent addresses AWS S3 at `https://<bucket>.s3.<region>.amazonaws.com`. Given, it is
  an absolute URL with no userinfo, no query and no fragment; `https:` always, `http:` only where
  the host is a loopback address. Anything else is `InvalidOption` at construction.
- Addressing is virtual-hosted by default and path-style with `forcePathStyle: true`. R2 requires
  `endpoint` set to `https://<account-id>.r2.cloudflarestorage.com` and `region: "auto"`.
- Every option is validated at construction. An unknown key is `InvalidOption`. `maxAttempts` takes
  the integers 1 to 3, `partSize` 5 MiB to 5 GiB in bytes, `concurrency` 1 to 16; outside those
  ranges the value is `InvalidOption` and is not clamped.
- `put` on `S3Storage` accepts the `PutOptions` of section 4.3 and nothing more. Storage class, ACL,
  tagging, object lock, versioning, server-managed encryption and checksum headers are not offered.
- Declares `presignedUrls`, `rangeReads`, `userMetadata` and `userMetadataTokenKeys`.
- `delete` sends at most one `DeleteObjects` request per 1000 keys, plus at most one `DELETE` per
  key holding `U+FFFE` or `U+FFFF` (section 7.4).

### 7.2 Promised providers

AWS S3 and Cloudflare R2, through one adapter that takes no `provider` option and detects nothing.
Where the two answer differently the adapter is written to the stricter side, and the parity core
promises what both hold (ADR 0014). Another endpoint that speaks the S3 wire protocol can be
configured and is not promised.

| Point                              | Promised                                                                                                                                |
| ---------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------- |
| Listing order                      | None. A page holds at most 1000 keys                                                                                                    |
| Unicode-equivalent keys            | May name one object (R2 normalizes to NFC) or two (S3 keeps both). `keyBytesPreserved` is not declared                                  |
| `userMetadata`                     | 2 KB of encoded header bytes; keys handed back in lower case                                                                            |
| Single `PUT`                       | Up to 5 GB                                                                                                                              |
| Object size ceiling                | The provider's, answered with `EntityTooLarge`                                                                                          |
| `Content-Type`                     | Always sent by `put`, `application/octet-stream` where none was given                                                                   |
| `CompleteMultipartUpload`          | Judged by its body, which may carry an error under `200`                                                                                |
| Writes per key                     | R2 answers `429` above one write per second and key; the retry of section 7.5 may recover a single collision, but does not guarantee it |
| Incomplete multipart uploads       | Removed by a lifecycle rule on AWS, after seven days by default on R2; stowage removes none                                             |
| Presigned URL host                 | The endpoint that signed it; on R2 the `r2.cloudflarestorage.com` endpoint and not a custom domain                                      |
| Response overrides on `presignGet` | Answered as the four response headers, on AWS and on R2                                                                                 |

### 7.3 Credentials

- `credentials` is required. No unsigned request is sent.
- The adapter resolves `credentials` before every request it signs and caches nothing between
  calls. A function is called with `{ forceRefresh: false }`, and with `{ forceRefresh: true }` once
  after the provider answered `Expired`; that one repeat has no delay and is not switched off by
  `retry: false`. Caching and rotation are the function's job.
- Before signing, `accessKeyId` and `secretAccessKey` are checked to be non-empty strings and every
  key of the resolved object to be one of the three; a violation is `InvalidCredentials` naming the
  field, with `attempts: 0`.
- `fromEnv` is a resolver, passed as `credentials: fromEnv`. It reads `AWS_ACCESS_KEY_ID`,
  `AWS_SECRET_ACCESS_KEY` and `AWS_SESSION_TOKEN` through `readEnvironment` of section 4.13, which
  reaches them on `workerd` under `nodejs_compat` and on Deno under `--allow-env`; a missing
  `process` or a refused read leaves the value empty. An empty `AWS_ACCESS_KEY_ID` or `AWS_SECRET_ACCESS_KEY` is
  `InvalidCredentials` naming that variable; a missing or empty `AWS_SESSION_TOKEN` is absent. It
  reads nothing else; `bucket`, `region` and `endpoint` come from the options alone.
- No package takes a connection URL. A caller holding one splits it into the four options; the
  `adapter-s3` README shows how.
- A presigned URL stops working when the credential that signed it expires, whatever `expiresIn`
  asked for.

### 7.4 Requests

- Every request is signed with SigV4 and carries `x-amz-content-sha256` over the body it sends. The
  adapter holds a body whole in order to hash it, so a request body never exceeds one part.
- `UNSIGNED-PAYLOAD` is sent by presigned URLs alone; there is no option to send it on a request the
  adapter makes, and no chunked signing.
- Every attempt resolves the credential again and signs again. The payload hash is computed once.
- Every request asks for the bytes as the provider stores them, `Accept-Encoding: identity`, so
  a provider that compresses on request cannot take the `Content-Length` a description reads.
- Every answer document goes through `parseXml` of section 4.13, listings, the multipart answers
  and `DeleteResult` alike, and what it refuses is `ProviderError`. An error document is read by a
  lenient reader of its own that decodes any reference, so its content never fails the error it
  reports.
- `ListObjectsV2` is sent with `encoding-type=url`, the walk of `deleteAll` included. Where the
  answer carries `EncodingType` `url`, `Contents/Key` and `CommonPrefixes/Prefix` are decoded, `+`
  to a space and then as percent-encoded UTF-8; a value that does not decode is `ProviderError`. The
  continuation token passes untouched, and the echoed `Prefix`, `Delimiter` and `StartAfter` are
  not read.
- A key holding `U+FFFE` or `U+FFFF`, which XML carries neither raw nor as a reference, leaves the
  `DeleteObjects` batch and is deleted by a `DELETE` of its own, after the batches and one after
  another, each on the budget of section 7.5. A `204` counts as deleted. A failure of the request
  as a whole rejects the call and stops the requests after it; any other failure becomes the key's
  entry in `failed` (ADR 0027).
- A key is percent-encoded segment by segment on the request path, so `#`, `%`, `?`, `+`, a space
  and characters above ASCII reach the provider as written.

### 7.5 Retries

- A failure is repeated when its condition is transient: a transport failure that received no
  response, and the statuses `408`, `429` and every `5xx`. No provider code adds to that group and
  none removes from it; `RequestTimeTooSkewed` arrives as `403` and is not repeated.
- The budget is per HTTP request: three attempts by default, `maxAttempts` at most, with a random
  delay between zero and `min(5 s, 100 ms × 2^n)` before attempt `n + 1`. `retry: false` sends one
  attempt. `Retry-After` is not read. For R2's same-key write window, the provider-blind policy may
  recover a collision but does not guarantee it.
- There is no total time budget and no timeout per attempt. The caller's `AbortSignal` is both, and
  it interrupts the wait between attempts.
- `CompleteMultipartUpload` is never repeated after a transport failure that received no response.
  `CreateMultipartUpload` is repeated, and an upload the first request created may be left behind.
- Only a body the adapter holds is sent again. Every request the adapter sends carries one, because
  a stream travels as buffered parts.
- One request costs at most six HTTP requests: three attempts, each doubled by the `Expired`
  repeat.
- A per-key failure in `delete` is reported, not repeated. A body stream that breaks during `get` is
  not resumed.
- The backoff numbers move in a minor release and never in a patch. The three-attempt ceiling is a
  promise.

### 7.6 Uploads

- A `Uint8Array` or string goes as one `PUT` up to 5 GB. Above that the provider answers
  `EntityTooLarge`; the adapter does not split held bytes.
- A `ReadableStream` is read into parts of `partSize`. A stream that ends within one part goes as
  one `PUT`. A stream that fills more than one part becomes a multipart upload with `concurrency`
  parts in flight.
- Defaults: `partSize` 8 MiB, `concurrency` 4, so an upload holds 32 MiB of part buffers for an
  object of any size. The part size is fixed before the first part and does not change during an
  upload. Both defaults move in a minor release and never in a patch.
- A stream that needs more than 10,000 parts, about 78 GiB at the default, fails with
  `InvalidRequest` naming the configured `partSize` and the way past it.
- A part that fails is repeated inside the upload on the budget of section 7.5. Once one part has
  spent its budget, the parts in flight are canceled, the source stream is canceled, the upload is
  aborted at the provider, and `put` rejects with that part's error.
- The caller's abort cancels the parts in flight, aborts the upload at the provider with a request
  that carries no signal, and rejects with `AbortError`. A failure of that abort request is not
  reported.
- Nothing about a multipart upload reaches the API: no progress, no upload id, no resume.

### 7.7 The one ambiguous outcome

When `CompleteMultipartUpload` receives no response, the commit may or may not have happened. The
adapter does not repeat the request and does not abort the upload. `put` rejects with
`NetworkError`, `retryable: true` and `attempts: 1`. `stat` settles the outcome only for a key the
caller knows was absent before the upload; parts of an upload that was not committed stay with the
provider until a lifecycle rule removes them.

### 7.8 Copies

- `copy` sends `CopyObject` and succeeds where the provider accepts it. Where the provider refuses
  the source as too large for one request, `copy` rejects with the provider's error; it does not
  fall back to `UploadPartCopy`. `move` inherits that.
- Both providers refuse a source above 5 GiB with `400`: AWS answers `InvalidRequest`, R2
  `EntityTooLarge`, and either reaches the caller as `InvalidRequest`.
- Copying a key onto itself is `InvalidRequest` before any request.

### 7.9 Provider codes

A recognized provider code decides the error code alone; an unrecognized one falls to the status
mapping of section 4.10. One table holds both vendors' strings.

| Provider code                                                                                                                                                                                                        | Error code           | Note                                                                                                        |
| -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------- | ----------------------------------------------------------------------------------------------------------- |
| `NoSuchKey`, `NoSuchBucket`                                                                                                                                                                                          | `NotFound`           |                                                                                                             |
| `AccessDenied`                                                                                                                                                                                                       | `AccessDenied`       |                                                                                                             |
| `InvalidAccessKeyId`, `SignatureDoesNotMatch`, `Unauthorized`                                                                                                                                                        | `InvalidCredentials` | `Unauthorized` at `401` is R2's                                                                             |
| `ExpiredToken`, `ExpiredRequest`                                                                                                                                                                                     | `Expired`            | `ExpiredRequest` is R2's; provisional                                                                       |
| `RequestTimeTooSkewed`, `InvalidRange`, `InvalidRequest`, `InvalidArgument`, `MetadataTooLarge`, `EntityTooLarge`, `EntityTooSmall`, `InvalidPart`, `InvalidPartOrder`, `BadDigest`, `MalformedXML`, `InvalidDigest` | `InvalidRequest`     | `InvalidRequest` is AWS's; `InvalidArgument` answered to `ListObjectsV2` is `InvalidOption` naming `cursor` |
| `InvalidObjectName`, `KeyTooLongError`                                                                                                                                                                               | `InvalidKey`         | Reached only for a key the core accepted                                                                    |
| `PermanentRedirect`                                                                                                                                                                                                  | `InvalidOption`      | Names `region` and the region from the header                                                               |
| `NoSuchUpload`, `SlowDown`, `TooManyRequests`, `ServiceUnavailable`, `InternalError`, `RequestTimeout`                                                                                                               | `ProviderError`      | The last five are transient by status                                                                       |

`status`, `providerCode`, `requestId` (from `x-amz-request-id`) and the provider's message are set
on every error that carries a response. `HEAD` carries no body, so `stat` and `exists` report the
status alone; a `400` for a key above 1024 bytes is `InvalidKey`, the `KeyTooLongError` the body
would have named.

### 7.10 Presigned URLs

```ts
export interface S3PresignGetOptions {
  expiresIn: number;
  responseContentType?: string;
  responseContentDisposition?: string;
  responseCacheControl?: string;
  responseExpires?: string;
}

export interface S3PresignPutOptions {
  expiresIn: number;
  contentType: string;
  contentLength: number;
}
```

- `expiresIn` is seconds, 1 to 604800; outside that it is `InvalidOption`. The credential that
  signs may cut the lifetime shorter.
- `contentLength` is a finite, non-negative integer. A negative, fractional, `NaN` or infinite
  value is `InvalidOption` naming `contentLength` before signing.
- `presignGet` signs `GetObject` on an addressable key. The four response overrides are sent as
  query parameters and are answered as the corresponding response headers.
- `presignPut` signs `PutObject` on a writable key with `Content-Type` and `Content-Length` bound
  exactly through signed headers, and returns the URL with `headers` holding `content-type`. A body
  of another type or another length is rejected by the provider. No user metadata, no checksum and
  no upper bound on the length can be signed in.
- The URL is a bearer token: whoever holds it may perform that one operation on that one key until
  it expires. It works against the endpoint that signed it only.
- Neither method sends a request. Both reject with `InvalidKey`, `InvalidOption` or
  `InvalidCredentials` before signing; a provider's rejection of the URL reaches whoever calls it and
  never the adapter. `@stowage/core` offers no function that turns such a response into a
  `StorageError`.
- There is no presigned `POST` and no presigned multipart upload.

## 8. `@stowage/adapter-azure-blob`

### 8.1 Construction

```ts
export type AzureBlobCredentials = { accountKey: string } | { accessToken: string };

export interface AzureBlobAdapterOptions {
  account: string;
  container: string;
  endpoint?: string;
  credentials: Resolvable<AzureBlobCredentials>;
  retry?: false | { maxAttempts?: number };
  multipart?: { partSize?: number; concurrency?: number };
}

export interface AzureBlobStorage extends Storage {
  readonly provider: "azure-blob";
  presignGet(key: string, options: AzureBlobPresignGetOptions): Promise<string>;
  presignPut(key: string, options: AzureBlobPresignPutOptions): Promise<PresignedPut>;
}

export function azureBlobStorage(options: AzureBlobAdapterOptions): AzureBlobStorage;
export function fromEnv(options?: ResolverOptions): { accountKey: string };
```

- `bucket` is the container. `account` is required configuration, not part of the credential: it
  names the endpoint and enters every Shared Key signature. Nothing reads it from the host or the
  environment (ADR 0021).
- `endpoint` absent addresses `https://<account>.blob.core.windows.net`. Given, it follows the
  rules of section 7.1: an absolute URL with no userinfo, no query and no fragment, `https:` always
  and `http:` only where the host is a loopback address; anything else is `InvalidOption` at
  construction. A path in it becomes the prefix of every request path, so Azurite's
  `http://127.0.0.1:10000/devstoreaccount1` is configured as it stands.
- Every option is validated at construction. An unknown key is `InvalidOption`. `maxAttempts` takes
  the integers 1 to 3, `partSize` 5 MiB to 4,000 MiB in bytes, `concurrency` 1 to 16; outside those
  ranges the value is `InvalidOption` and is not clamped. A configuration shared with `adapter-s3`
  stays within 5 MiB and 4,000 MiB.
- `put` on `AzureBlobStorage` accepts the `PutOptions` of section 4.3 and nothing more. Append and
  page blobs, access tiers, snapshots, soft delete, versioning, leases, immutability policies and
  blob index tags are not offered.
- Declares `presignedUrls`, `rangeReads` and `userMetadata`. It does not declare
  `userMetadataTokenKeys`, and not `keyBytesPreserved` until a run against the account settles how
  Azure treats Unicode-equivalent names (section 13).
- Refuses three kinds of writable key with `InvalidKey` and `attempts: 0`: more than 254
  segments, a segment ending in `.`, and a key holding a character from `U+0080` to `U+009F`.
  Addressable keys and prefixes are refused by nothing beyond the rule of section 4.8 (ADR 0020).
- `delete` sends at most one Blob Batch request per 256 keys.

### 8.2 Promised provider

Azure Blob Storage in the public cloud: a general-purpose v2 account without hierarchical
namespace, holding block blobs. An account with hierarchical namespace, a sovereign cloud and
another endpoint that speaks the Blob wire protocol can be configured and are not promised.

| Point                              | Promised                                                                                                                                       |
| ---------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------- |
| Listing order                      | None. A page holds at most 1000 names                                                                                                          |
| Unicode-equivalent keys            | Undocumented. `keyBytesPreserved` is not declared                                                                                              |
| `userMetadata`                     | ASCII identifier keys, handed back in the case they were written in; 2 KB as section 4.3 measures them                                         |
| Single `Put Blob`                  | Up to 5,000 MiB                                                                                                                                |
| Object size ceiling                | 50,000 blocks of at most 4,000 MiB; the upload of section 8.6 stops at 50,000 parts                                                            |
| `Content-Type`                     | Always sent by `put`, on the commit of a block upload as well, `application/octet-stream` where none was given                                 |
| Writes per key                     | Of two writers, one may be rejected (section 8.6)                                                                                              |
| Uncommitted blocks                 | Kept until the next commit or `Put Blob` to the name, or until the service discards them seven days after the last block; stowage removes none |
| Presigned URL host                 | The endpoint that signed it                                                                                                                    |
| Response overrides on `presignGet` | Answered as the three response headers                                                                                                         |

### 8.3 Credentials

- `credentials` is required. `{ accountKey }` signs requests with Shared Key. `{ accessToken }` is
  an Entra ID bearer token for the scope `https://storage.azure.com/.default`, which the caller's
  resolver obtained. Both are promised on all four runtimes. The adapter tells them apart by the
  field present; a resolver may answer one form on one call and the other on the next, and each
  request is signed with what it resolved to.
- The adapter resolves `credentials` before every request it signs and caches nothing between
  calls. A function is called with `{ forceRefresh: false }`, and with `{ forceRefresh: true }` once
  after the provider answered `401 InvalidAuthenticationInfo` to a request under an access token,
  which is the one answer an expired token hides behind; that repeat has no delay and is not
  switched off by `retry: false`. Where the repeat is refused too, the failure is
  `InvalidCredentials` with `attempts: 2`, and its message says that the token expired or is not
  accepted. The adapter never reports `Expired`.
- Before signing, the resolved object is checked to hold exactly one of the two fields, as a
  non-empty string, and no other field, and an `accountKey` to decode as base64 to at least one
  byte; a violation is `InvalidCredentials` naming the field, with `attempts: 0`. An access token is
  opaque and is not parsed.
- An account whose `AllowSharedKeyAccess` is `false` answers an account key with
  `403 KeyBasedAuthenticationNotPermitted`. That is `InvalidCredentials`, not repeated, and its
  message names the access token as the form such an account accepts.
- `fromEnv` is a resolver, passed as `credentials: fromEnv`. It reads `AZURE_STORAGE_KEY` through
  `readEnvironment` of section 4.13 and answers `{ accountKey }`; an empty value is
  `InvalidCredentials` naming the variable. It reads neither the account, nor a connection string,
  nor an access token.
- No SAS token is taken as a credential, and no token is acquired: no client secret, no managed
  identity, no workload identity. A caller holding an `@azure/identity` credential wraps its
  `getToken` in a resolver of their own.
- No package takes a connection string. A caller holding one splits it into `account`, `endpoint`
  and `credentials`; the `adapter-azure-blob` README shows how.
- A presigned URL signed under an account key works until it expires or the key is regenerated.
  One signed under an access token outlives the token and stops working when its user delegation
  key expires, which is when the URL does; revoking the account's user delegation keys, or the role
  assignment behind the token, revokes it, after a delay of Azure's.

### 8.4 Requests

- Every request carries `x-ms-version: 2026-04-06`, and every SAS the adapter signs `sv=2026-04-06`.
- Under an account key a request is signed with Shared Key, which signs the length and no hash of
  the body. Canonical headers are ordered by code point with `_` placed before the digits, never
  by a runtime's collation. Under an access token a request carries it as `Authorization: Bearer`.
- Every request carries a body the adapter holds; Azure refuses a chunked `Put Blob`, so a stream
  travels as held parts (section 8.6).
- A key is percent-encoded segment by segment on the request path, as in section 7.4.
- Listings are `List Blobs` answers, read through `parseXml` of section 4.13. A `Name` marked
  `Encoded="true"`, which is how Azure carries a name holding `U+FFFE` or `U+FFFF`, is decoded as
  percent-encoded UTF-8.
- A `userMetadata` value holding a run of whitespace is sent as encoded words even where it would
  travel as written, and read back decoded, so no header value holds a run the signature would have
  to settle.
- `stat` and `exists` read the provider code from `x-ms-error-code`, which Azure sends on a `HEAD`
  as well, so a missing blob and a missing container carry their own codes.
- `delete` sends Blob Batch requests of at most 256 `Delete Blob` subrequests. A subrequest
  answered `404 BlobNotFound` counts as deleted. Any other failed subrequest becomes the key's
  entry in `failed`, with the code section 8.8 maps; a failure of the batch request as a whole
  rejects the call.

### 8.5 Retries

- Section 7.5 holds here: the transient conditions, the budget of three attempts per HTTP request,
  `maxAttempts`, the curve, `retry: false`, no `Retry-After`, no total time budget and no timeout
  per attempt. Azure throttles with `503 ServerBusy` and `500 OperationTimedOut`, which the status
  group already holds.
- `Put Block List` names every block as `<Latest>` and is repeated like every other request, after
  a transport failure that received no response too: a repeat commits the same blocks in the same
  order. Section 7.7 is S3's alone, and a `put` of any size is answered with certainty, except
  where another writer replaced the key between a lost commit and its repeat (section 8.6).
- The repeat after `401 InvalidAuthenticationInfo` of section 8.3 doubles an attempt as the
  `Expired` repeat does on S3, so one request costs at most six HTTP requests.
- A per-key failure in `delete` is reported, not repeated. A body stream that breaks during `get` is
  not resumed.

### 8.6 Uploads

- A `Uint8Array` or string goes as one `Put Blob` up to 5,000 MiB. Above that Azure answers
  `413 RequestBodyTooLarge`, which is `InvalidRequest`; the adapter does not split held bytes.
- A `ReadableStream` is read into parts of `partSize`. A stream that ends within one part goes as
  one `Put Blob`. A stream that fills more than one part is staged as blocks with `concurrency`
  parts in flight and committed with one `Put Block List`, which carries the content type and the
  user metadata.
- Defaults: `partSize` 8 MiB, `concurrency` 4, as on S3. Both move in a minor release and never in
  a patch.
- A stream that needs more than 50,000 parts, about 390 GiB at the default, fails with
  `InvalidRequest` naming the configured `partSize` and the way past it.
- Block ids are drawn at random per upload and have one fixed length (ADR 0024), so two writers to
  one key never stage each other's blocks. Of two writers, the one whose blocks the other's commit
  discarded is rejected with `ProviderError`, `retryable: false`: `InvalidBlockList` on its
  commit, or `InvalidBlobOrBlock` on a `Put Block` where another tool staged ids of another length
  under the name. It is the case section 4.11 allows, and the key holds the other writer's object.
- A part that fails is repeated inside the upload on the budget of section 8.5. Once one part has
  spent its budget, the parts in flight are canceled, the source stream is canceled, and `put`
  rejects with that part's error. The caller's abort cancels the parts in flight and rejects with
  `AbortError`.
- Nothing is sent after an upload stops, since nothing aborts a block upload and `Delete Blob`
  would delete a committed object of another writer. The staged blocks stay until the next commit
  or `Put Blob` to the name, or until the service discards them seven days after the last block.
  The API does not see them: `stat` and `get` answer `NotFound` for a name that holds only
  uncommitted blocks, `list` does not show it, and an object already under the key reads as before.
- A name that meets many failed uploads within seven days can reach Azure's 100,000 uncommitted
  blocks, and a `Put Block` to it is refused with `409 BlockCountExceedsLimit`, which is
  `InvalidRequest`, until a commit or the seven days clear them.
- Nothing about a block upload reaches the API: no progress, no block list, no resume.

### 8.7 Copies

- `copy` sends one `Put Blob From URL`, which is synchronous, and succeeds up to a source of
  5,000 MiB. Nothing is sent in front of it. The service copies the content type and the user
  metadata of the source; the destination is replaced once the copy succeeded, and a failure leaves
  it as it was.
- The request authorizes its source. Under an account key it carries a service SAS for the source,
  signed for each attempt with `sp=r`, `sr=b`, `st` 15 minutes in the past and `se` 60 minutes from
  now. Under an access token it carries `x-ms-copy-source-authorization: Bearer` with the token of
  its own `Authorization`, so the repeat of section 8.3 renews both.
- Above 5,000 MiB the service answers `409`, which is `InvalidRequest` saying that the source is
  above 5,000 MiB or reported no valid length. There is no fallback to blocks copied by range or to
  `Copy Blob`. `move` inherits that.
- `move` is `copy` followed by an unconditional `Delete Blob` on `from`.
- Copying a key onto itself is `InvalidRequest` before any request.

### 8.8 Provider codes

A recognized provider code decides the error code alone; an unrecognized one falls to the status
mapping of section 4.10. `status`, `providerCode` from `x-ms-error-code`, `requestId` from
`x-ms-request-id`, and the provider's message where a body carries one are set on every error that
carries a response.

| Provider code                                                                                                            | Error code           | Note                                                                                                                                                                                  |
| ------------------------------------------------------------------------------------------------------------------------ | -------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `BlobNotFound`, `ContainerNotFound`, `ResourceNotFound`                                                                  | `NotFound`           | `BlobNotFound` on `delete` counts as deleted                                                                                                                                          |
| `AuthorizationPermissionMismatch`, `InsufficientAccountPermissions`, `AccountIsDisabled`, `UnauthorizedBlobOverwrite`    | `AccessDenied`       | The principal is authenticated and lacks the role                                                                                                                                     |
| `InvalidAuthenticationInfo`, `NoAuthenticationInformation`, `AuthenticationFailed`, `KeyBasedAuthenticationNotPermitted` | `InvalidCredentials` | `InvalidAuthenticationInfo` under an access token after the one repeat of section 8.3; `AuthenticationFailed` includes a clock skew, which Azure does not tell apart from a wrong key |
| `InvalidRange`, `RequestBodyTooLarge`, `BlockCountExceedsLimit`, `MetadataTooLarge`, `InvalidMetadata`                   | `InvalidRequest`     | The metadata codes are reached only for metadata the core accepted                                                                                                                    |
| `InvalidBlockList`, `InvalidBlobOrBlock`                                                                                 | `ProviderError`      | `retryable: false`; on a block upload, usually another writer won (section 8.6)                                                                                                       |
| `PendingCopyOperation`, `BlobArchived`, `SnapshotsPresent`, `LeaseIdMissing`, `BlobImmutableDueToPolicy`                 | `ProviderError`      | A state of the blob stowage does not create                                                                                                                                           |
| `ServerBusy`, `InternalError`, `OperationTimedOut`                                                                       | `ProviderError`      | Transient by status                                                                                                                                                                   |
| `CannotVerifyCopySource`                                                                                                 | By the source        | Mapped through `x-ms-copy-source-status-code` where present, else the response's status, with `key` set to `from`                                                                     |

- On `Put Blob From URL`, a `409` whose code the table does not name is `InvalidRequest` (section
  8.7).
- A `400` for a key above 1,024 characters or 254 segments is `InvalidKey`, as section 7.9 has it
  for S3: an addressable key the provider cannot hold.

### 8.9 Presigned URLs

```ts
export interface AzureBlobPresignGetOptions {
  expiresIn: number;
  responseContentType?: string;
  responseContentDisposition?: string;
  responseCacheControl?: string;
}

export interface AzureBlobPresignPutOptions {
  expiresIn: number;
  contentType: string;
  contentLength: number;
}
```

A URL is a SAS, and the credential of the call decides which kind (ADR 0022):

| Credential    | `presignGet`          | `presignPut`                                |
| ------------- | --------------------- | ------------------------------------------- |
| `accountKey`  | A service SAS         | `InvalidCredentials` naming `accountKey`    |
| `accessToken` | A user delegation SAS | A user delegation SAS binding three headers |

- `expiresIn` and `contentLength` take what section 7.10 has them take, and are checked before
  anything is sent. `contentLength` is not checked against the 5,000 MiB of a single `Put Blob`.
- `presignGet` signs `sp=r` on an addressable key. The three response overrides are sent as `rsct`,
  `rscd` and `rscc` and are answered as the corresponding response headers. Azure has no override
  for `Expires`.
- `presignPut` signs `sp=w` on a writable key with
  `srh=content-type,content-length,x-ms-blob-type` and returns `headers` holding `content-type`
  and `x-ms-blob-type: BlockBlob`. A body of another content type, one differing in case or
  parameters included, a body of another length, and another blob type are rejected with
  `403 AuthenticationFailed`; a request without `x-ms-blob-type` with `400 MissingRequiredHeader`.
  An existing blob is overwritten, as a presigned `PUT` does on S3.
- Under an account key `presignPut` rejects before any request, because a service SAS binds no
  request header. Its message says that `presignPut` needs an access token.
- Every SAS carries `sr=b`, `st` 15 minutes in the past and `se` `expiresIn` seconds from now, and
  `spr=https`, or `https,http` where the endpoint is a loopback address; none carries `sip`. An
  account with a SAS expiration policy therefore measures `expiresIn + 900` seconds.
- Under an access token each call requests one user delegation key, valid from `st` to `se`, and
  keeps it nowhere; it is an ordinary request of the adapter under sections 8.3 and 8.5, and a
  refusal of it is `AccessDenied`. The principal needs the account's
  `generateUserDelegationKey` action and the data role for the operation it signs.
- The URL is a bearer token: whoever holds it may perform that one operation on that one key until
  it expires. It works against the endpoint that signed it only.
- There is no presigned block upload.

## 9. `@stowage/conformance`

### 9.1 Exports

```ts
export interface ConformanceTarget {
  readonly name: string;
  createStorage(): Storage | Promise<Storage>;
  cleanup?(keyPrefix: string): Promise<void>;
  createStorageWithBadCredentials?(): Storage | Promise<Storage>;
  createStorageWithExpiredCredentials?(): Storage | Promise<Storage>;
  createStorageWithDeniedCredentials?(): Storage | Promise<Storage>;
}

export interface ConformanceContext {
  readonly storage: Storage;
  readonly keyPrefix: string;
  readonly target: ConformanceTarget;
  declares(name: CapabilityName): boolean;
}

export type ConformanceCase =
  | {
      readonly name: string;
      readonly requires: readonly [];
      readonly cost: "fast" | "slow";
      run(ctx: ConformanceContext): Promise<void>;
    }
  | {
      readonly name: string;
      readonly requires: readonly [CapabilityName, ...CapabilityName[]];
      readonly cost: "fast" | "slow";
      run(ctx: ConformanceContext): Promise<void>;
      runWithout(ctx: ConformanceContext): Promise<void>;
    };

export const conformanceCases: readonly ConformanceCase[];

export interface ConformanceRunOptions {
  includeSlow?: boolean;
}

export interface ConformanceFramework extends ConformanceRunOptions {
  describe(name: string, body: () => void): void;
  test(name: string, body: () => Promise<void>): void;
}

export function describeConformance(
  target: ConformanceTarget,
  framework: ConformanceFramework,
): void;
export function runAll(
  target: ConformanceTarget,
  options?: ConformanceRunOptions,
): Promise<readonly ConformanceResult[]>;
export function expectUnsupported(
  call: () => Promise<unknown>,
  capability: CapabilityName,
): Promise<void>;

export interface ConformanceCaseMetadata {
  readonly name: string;
  readonly requires: readonly CapabilityName[];
  readonly cost: "fast" | "slow";
}

export interface SerializedConformanceError {
  readonly name: string;
  readonly message: string;
  readonly stack?: string;
  readonly code?: StorageErrorCode;
}

export type ConformanceMode = "declared" | "without";

export type ConformanceResult =
  | {
      readonly case: ConformanceCaseMetadata;
      readonly status: "passed";
      readonly mode: ConformanceMode;
    }
  | { readonly case: ConformanceCaseMetadata; readonly status: "skipped"; readonly reason: string }
  | {
      readonly case: ConformanceCaseMetadata;
      readonly status: "failed";
      readonly mode: ConformanceMode;
      readonly error: SerializedConformanceError;
    };
```

### 9.2 Running the suite

- `describeConformance(target, { describe, test })` maps every case onto the test functions of
  Vitest, `bun:test` or `Deno.test`. `runAll(target)` runs every case and returns the results, for
  `workerd` and any runtime without a test framework. Both run the `fast` cases by default and both
  tiers with `includeSlow: true`.
- A run generates one `keyPrefix` and every final key begins with it. Its boundary key is exactly
  1024 UTF-8 bytes total. `cleanup(keyPrefix)` runs once at the end and defaults to
  `deleteAll(keyPrefix)` on a fresh storage. Two runs against one bucket do not interfere.
- The declaration is read from the storage once per run, before the first case. Every storage the
  target creates in one run declares the same; two configurations are two targets.
- A target runs the suite under a credential with which every declared capability works. For
  `adapter-azure-blob` that is an access token, since `presignPut` refuses an account key by design
  (ADR 0023).
- A case whose `requires` are all declared runs `run`; a case missing one runs `runWithout`. The
  result says which half ran in `mode`. A case that needs an optional factory the target does not
  supply reports `skipped` with the factory's name as `reason`.
- `runAll` normalizes a thrown value to `name` and `message`, adds `stack` where present and `code`
  where the value is a `StorageError`. It never exposes `cause`.
- `expectUnsupported(call, capability)` runs `call` and asserts a `StorageError` with
  `code: "Unsupported"` and that `capability`.

### 9.3 What the target promises

- `createStorage()` returns a storage the run may write to below any prefix, constructed from
  outside the adapter. What it supports the suite reads from the storage.
- `createStorageWithBadCredentials()` returns a storage whose credential the provider refuses.
- `createStorageWithExpiredCredentials()` returns a storage whose credential has already expired.
- `createStorageWithDeniedCredentials()` returns a storage whose credential the provider accepts
  and that may read the bucket and not write to it.

### 9.4 What the suite does not assert

The suite asserts what the core API can observe. The following are promises of this repository's
adapters, tested in this repository and not by the suite:

- On S3, a failed upload leaves no multipart upload behind (flow 1).
- Memory stays flat during a large upload and a streaming download (flows 1 and 4).
- A body stream that breaks partway through `get` arrives as a `StorageError`.
- The retry group, the backoff curve, the two exceptions of section 7.5 and the stream rule, against
  a stubbed `fetch`.
- The refusal of a copy the provider rejects as too large (sections 7.8 and 8.7), against a stubbed
  `fetch`.
- The four response overrides on `presignGet` of `adapter-s3` (section 7.10) and the three of
  `adapter-azure-blob` (section 8.9), against the real endpoints in the `slow` tier.
- Keys ending in `/` and keys above 1024 bytes written by another tool appear in a listing and are
  readable, against the S3 adapter with the AWS SDK as the writer.
- A `delete` in `adapter-s3` sends a key holding `U+FFFE` as a `DELETE` of its own while its
  neighbours stay in the batch, against SeaweedFS on every commit.
- The account key of `adapter-azure-blob`, which the suite does not run under (section 9.2): Shared
  Key signatures across the operations of the parity core, with user metadata named `a1` and `a_`
  and a value holding a run of spaces; `presignGet` as a service SAS; `presignPut` refused before any
  request; and a `copy`, once the pinned Azurite carries `Put Blob From URL`. Against Azurite on
  every commit and the account in the `slow` tier.
- The repeat after `401 InvalidAuthenticationInfo` under an access token (section 8.3), against a
  stubbed `fetch`: one resolver call with `forceRefresh: true`, then success, or
  `InvalidCredentials` after a second `401`.
- `Put Block List` sent again after a lost response with the headers it carried, against a stubbed
  `fetch`; the same commit sent twice answering `201` and leaving the same bytes, and a `Put Blob`
  discarding the uncommitted blocks of its name, against the account in the `slow` tier.
- The CORS headers on the `403` for an expired presigned URL on Azure, after a preflight from the
  origin the account's rule allows, in the `slow` tier.
- The divergences of each emulator from the provider it stands in for, kept as a list in the
  private harness (ADR 0012, ADR 0023).

### 9.5 Cases

Names are stable: a renamed case is a removed case and an added one. `fast` cases run on every
pull request. A case with `requires` carries a `runWithout` half, described in the last column.
A case marked with a factory is skipped where the target does not supply it.

**Declaration**

| Case                      | Requires | Cost   | Asserts                                                             |
| ------------------------- | -------- | ------ | ------------------------------------------------------------------- |
| `declaration/valid-names` |          | `fast` | `capabilities` holds only names out of `capabilityNames`, each once |
| `declaration/identity`    |          | `fast` | `provider` and `bucket` are non-empty strings                       |

**`put`**

| Case                           | Requires                                | Cost   | Asserts                                                                                                                                                                                                                        |
| ------------------------------ | --------------------------------------- | ------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `put/bytes-round-trip`         |                                         | `fast` | A `Uint8Array` reads back byte for byte through `bytes()`; the returned `ObjectStat` and a later `stat` agree on `key`, `size` and `contentType`                                                                               |
| `put/string-round-trip`        |                                         | `fast` | A string with characters above ASCII reads back equal through `text()`; `size` is its UTF-8 length                                                                                                                             |
| `put/stream-round-trip`        |                                         | `fast` | A 1 MiB stream reads back byte for byte                                                                                                                                                                                        |
| `put/multipart-round-trip`     |                                         | `fast` | A 17 MiB stream of a generated pattern reads back byte for byte; `stat` reports the size                                                                                                                                       |
| `put/empty-body`               |                                         | `fast` | An empty `Uint8Array` and a stream that yields nothing both produce an object of size 0 that reads back empty                                                                                                                  |
| `put/overwrites`               |                                         | `fast` | A second `put` under the same key replaces bytes and content type                                                                                                                                                              |
| `put/content-type-stored`      |                                         | `fast` | `contentType: "text/plain"` on a key ending in `.txt` is reported by `stat` and `get`                                                                                                                                          |
| `put/content-type-default`     |                                         | `fast` | Without `contentType`, a key without an extension reports `application/octet-stream`                                                                                                                                           |
| `put/accepted-keys`            |                                         | `fast` | Each key of the accepted list (section 9.7) round-trips and is listed under its prefix                                                                                                                                         |
| `put/refused-keys`             |                                         | `fast` | Each key of the refused writable list rejects with `InvalidKey`, `attempts: 0`, and `exists` afterwards is `false` where the key is addressable, or rejects with `InvalidKey` for a key the provider cannot hold (section 9.7) |
| `put/unknown-option`           |                                         | `fast` | An unknown option key rejects with `InvalidOption` whose message names the key; nothing was written                                                                                                                            |
| `put/aborted-signal`           |                                         | `fast` | A signal already aborted rejects with `AbortError`; nothing was written                                                                                                                                                        |
| `put/abort-during-upload`      |                                         | `fast` | Aborting during a 17 MiB stream rejects with `err.name === "AbortError"` and not a `StorageError`                                                                                                                              |
| `put/stream-consumed`          |                                         | `fast` | After `put`, the source stream is closed or canceled; reading it yields `done`                                                                                                                                                 |
| `put/user-metadata`            | `userMetadata`                          | `fast` | Two entries with identifier keys round-trip through `stat` and `get`, keys compared case-insensitively. Without: a non-empty object is `Unsupported` naming `userMetadata`; `{}` passes and reads back `{}`                    |
| `put/user-metadata-limits`     | `userMetadata`                          | `fast` | A key with a character above ASCII and a set of identifier keys over 2 KB each reject with `InvalidRequest`, `attempts: 0`. Without: both are `Unsupported`                                                                    |
| `put/user-metadata-token-keys` | `userMetadata`, `userMetadataTokenKeys` | `fast` | A key `content-hash` round-trips through `stat` and `get`. Without: it is `Unsupported`, `attempts: 0`, naming `userMetadataTokenKeys` where `userMetadata` is declared and `userMetadata` where it is not                     |
| `put/concurrent-writers`       |                                         | `fast` | Two streamed `put`s of 17 MiB, one of a pattern A and one of a pattern B, paced so that each has sent a part before either completes: each resolves or rejects, at least one resolves, and `get` returns A or B byte for byte  |

**`get`**

| Case                      | Requires     | Cost   | Asserts                                                                                                                                 |
| ------------------------- | ------------ | ------ | --------------------------------------------------------------------------------------------------------------------------------------- |
| `get/missing-key`         |              | `fast` | Rejects with `NotFound`, `key` set, `operation: "get"`, `retryable: false`, `attempts: 1`                                               |
| `get/stream`              |              | `fast` | `stream()` yields the bytes; canceling it does not reject                                                                               |
| `get/text-and-json`       |              | `fast` | `text()` decodes UTF-8; `json()` parses; a body that is not JSON rejects `json()` with `SyntaxError` and not a `StorageError`           |
| `get/body-read-once`      |              | `fast` | A second reader after `bytes()` rejects with `InvalidRequest`                                                                           |
| `get/stat-from-response`  |              | `fast` | `stat` on the stored object equals `stat()` in `key`, `size`, `contentType`, `etag`                                                     |
| `get/addressable-keys`    |              | `fast` | A key ending in `/` and a key holding a backslash reject with `NotFound`, not `InvalidKey`                                              |
| `get/aborted-signal`      |              | `fast` | A signal already aborted rejects with `AbortError`                                                                                      |
| `get/range`               | `rangeReads` | `fast` | `{ start, end }` returns those bytes inclusive; `{ start }` returns to the end; `stat.size` is the whole object. Without: `Unsupported` |
| `get/range-unsatisfiable` | `rangeReads` | `fast` | `start` at the size rejects with `InvalidRequest`; `start > end` with `InvalidOption`. Without: `Unsupported`                           |
| `get/range-clipped`       | `rangeReads` | `fast` | `end` beyond the size returns to the end. Without: `Unsupported`                                                                        |

**`stat` and `exists`**

| Case                    | Requires | Cost   | Asserts                                                                                                           |
| ----------------------- | -------- | ------ | ----------------------------------------------------------------------------------------------------------------- |
| `stat/describes-object` |          | `fast` | `key`, `size`, `contentType` as written; `lastModified` a `Date` within a minute of now; `userMetadata` an object |
| `stat/missing-key`      |          | `fast` | Rejects with `NotFound`, `operation: "stat"`                                                                      |
| `exists/answers`        |          | `fast` | `true` for a stored key, `false` for an absent one and for an absent key ending in `/`                            |
| `exists/invalid-key`    |          | `fast` | A key with a `..` segment rejects with `InvalidKey` rather than answering `false`                                 |

**`list`**

| Case                      | Requires            | Cost   | Asserts                                                                                                                                                      |
| ------------------------- | ------------------- | ------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `list/nothing`            |                     | `fast` | A prefix holding nothing yields no entry, and `page()` returns empty `objects`, empty `prefixes`, no `cursor`                                                |
| `list/every-object-once`  |                     | `fast` | 25 objects under a prefix are each yielded once; membership, not order                                                                                       |
| `list/entry-shape`        |                     | `fast` | Every entry has `key`, a numeric `size` equal to what was written and a `Date` `lastModified`                                                                |
| `list/pages-and-cursor`   |                     | `fast` | `pageSize: 2` over 5 objects: pages of 2, 2, 1; each page but the last carries a `cursor`; a new `list` with that cursor continues; the union is all 5       |
| `list/delimiter`          |                     | `fast` | With `/`: `objects` holds the keys at that level, `prefixes` the pseudo-directories once each ending in `/`; iteration yields the objects at that level only |
| `list/prefix-mid-segment` |                     | `fast` | A prefix ending inside a segment matches the keys that start with it and no others                                                                           |
| `list/lazy`               |                     | `fast` | `list()` without iteration or `page()` performs no request; a later `page()` on a `pageSize` of 0 rejects with `InvalidOption`                               |
| `list/page-size-bounds`   |                     | `fast` | `pageSize` of 0 and of 1001 reject with `InvalidOption` naming `pageSize`                                                                                    |
| `list/invalid-cursor`     |                     | `fast` | A cursor the storage did not produce rejects with `InvalidOption` naming `cursor`                                                                            |
| `list/invalid-delimiter`  |                     | `fast` | An empty delimiter rejects with `InvalidOption`                                                                                                              |
| `list/past-one-thousand`  |                     | `slow` | 1001 objects: iteration yields all; a `page()` at the default size holds at most 1000 and carries a `cursor`                                                 |
| `list/key-bytes`          | `keyBytesPreserved` | `fast` | A key in NFC and the same key in NFD are two objects and both come back byte for byte. Without: each comes back Unicode-equivalent to what was written       |
| `list/noncharacter-key`   |                     | `fast` | A key holding `U+FFFE` is written, comes back byte for byte through `list` and `get`, and is deleted                                                         |

**`delete` and `deleteAll`**

| Case                          | Requires | Cost   | Asserts                                                                                                                |
| ----------------------------- | -------- | ------ | ---------------------------------------------------------------------------------------------------------------------- |
| `delete/single`               |          | `fast` | One key: `requested: 1`, `failed` empty, `exists` is `false` afterwards                                                |
| `delete/many`                 |          | `fast` | 30 keys in one call: `requested: 30`, all gone                                                                         |
| `delete/absent-key-succeeds`  |          | `fast` | An absent key: `requested: 1`, `failed` empty                                                                          |
| `delete/nothing`              |          | `fast` | No key: `requested: 0`, `failed` empty                                                                                 |
| `delete/invalid-key-reported` |          | `fast` | One key with a `..` segment among two valid ones: `failed` holds one `InvalidKey` with that `key`, the two are deleted |
| `delete/past-one-thousand`    |          | `slow` | 1001 keys in one call are all deleted                                                                                  |
| `deleteAll/below-prefix`      |          | `fast` | Deletes the objects below the prefix and none beside it; `requested` equals their count                                |
| `deleteAll/nothing`           |          | `fast` | A prefix holding nothing: `requested: 0`                                                                               |
| `deleteAll/past-one-thousand` |          | `slow` | 1001 objects below a prefix are all deleted in one call                                                                |

**`copy` and `move`**

| Case                  | Requires       | Cost   | Asserts                                                                                                                        |
| --------------------- | -------------- | ------ | ------------------------------------------------------------------------------------------------------------------------------ |
| `copy/round-trip`     |                | `fast` | Destination has the bytes and content type; source is unchanged; the returned `ObjectStat` names the destination               |
| `copy/overwrites`     |                | `fast` | A destination that exists is replaced                                                                                          |
| `copy/missing-source` |                | `fast` | Rejects with `NotFound`; no destination is created                                                                             |
| `copy/onto-itself`    |                | `fast` | `from === to` rejects with `InvalidRequest`, `attempts: 0`; the object is unchanged                                            |
| `copy/invalid-keys`   |                | `fast` | A destination ending in `/` and a source with a `..` segment each reject with `InvalidKey` before anything changes             |
| `copy/user-metadata`  | `userMetadata` | `fast` | The destination carries the source's metadata under identifier keys. Without: the copy succeeds and the destination reads `{}` |
| `move/round-trip`     |                | `fast` | Destination has the bytes and content type; source is gone; the result names the destination                                   |
| `move/missing-source` |                | `fast` | Rejects with `NotFound`, `operation: "move"`; no destination is created                                                        |

**Errors**

| Case                         | Requires | Cost   | Asserts                                                                                                                                                                                             |
| ---------------------------- | -------- | ------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `errors/shape`               |          | `fast` | Every error the run provokes passes `isStorageError`, has a `code` out of the union, `operation`, `bucket` and `provider` matching the storage, a boolean `retryable` and an integer `attempts`     |
| `errors/not-a-storage-error` |          | `fast` | `AbortError` and `SyntaxError` from the cases above fail `isStorageError`                                                                                                                           |
| `errors/bad-credentials`     |          | `fast` | Factory `createStorageWithBadCredentials`: `get` rejects with `InvalidCredentials`, `retryable: false` and `attempts` of `1` or `2`; `exists` rejects rather than answering `false`; `list` rejects |
| `errors/denied-credentials`  |          | `fast` | Factory `createStorageWithDeniedCredentials`: `put` rejects with `AccessDenied`, `retryable: false`, `attempts: 1`                                                                                  |
| `errors/expired-credentials` |          | `slow` | Factory `createStorageWithExpiredCredentials`: `get` rejects with `Expired` and `attempts: 2`                                                                                                       |

**Presigned URLs**

| Case                         | Requires        | Cost   | Asserts                                                                                                                                             |
| ---------------------------- | --------------- | ------ | --------------------------------------------------------------------------------------------------------------------------------------------------- |
| `presign/get`                | `presignedUrls` | `fast` | `fetch` on the URL answers `200`, the bytes and the content type. Without: `"presignGet" in storage` and `"presignPut" in storage` are both `false` |
| `presign/put`                | `presignedUrls` | `fast` | `fetch` with `PUT`, the returned `headers` and a body of the signed length answers `2xx`; `stat` reports the type and size. Without: as above       |
| `presign/expires-in-bounds`  | `presignedUrls` | `fast` | `expiresIn` of 0 and of 604801 reject with `InvalidOption`; no request is made. Without: as above                                                   |
| `presign/put-rejects-type`   | `presignedUrls` | `slow` | A body with another content type answers `403`. Without: as above                                                                                   |
| `presign/put-rejects-length` | `presignedUrls` | `slow` | A body of another length answers `4xx`. Without: as above                                                                                           |
| `presign/expired-url`        | `presignedUrls` | `slow` | A URL signed with `expiresIn: 1`, called after two seconds, answers `403`. Without: as above                                                        |

### 9.6 Reference flow cases

| Case                        | Requires        | Cost   | Asserts                                                                                                                                                                                |
| --------------------------- | --------------- | ------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `flow/1-large-upload`       |                 | `fast` | A 17 MiB stream with a content type is stored and reads back byte for byte; an abort during a second upload of the same size rejects with `AbortError` and leaves the key absent       |
| `flow/2-presigned-put`      | `presignedUrls` | `fast` | Sign for a reported length and type, upload with `fetch` and the returned `headers`, `stat` reports both. Without: the methods are absent                                              |
| `flow/3-file-browser`       |                 | `fast` | A tree of 7 objects in 3 pseudo-directories: one `page()` with `/` and `pageSize: 5` returns the level's objects and the 3 prefixes; a new listing with the cursor completes the level |
| `flow/4-streaming-download` | `rangeReads`    | `fast` | `get` with a range streamed into a `Response` yields the range's bytes and the content type. Without: `get` without a range streams the whole object, and a range is `Unsupported`     |
| `flow/5-prefix-move`        |                 | `fast` | Every object below one prefix is streamed from `get` into `put` below another prefix with its content type; `deleteAll` on the source reports their count; the target lists them all   |

### 9.7 Key lists

Every adapter accepts each key of the accepted list for `put` and refuses each key of the refused
lists for the rule named. A key is given as its characters; its length is measured in UTF-8 bytes.

- Accepted: `a`; `hello world.txt`; `docs/2026/report.pdf`; `a#b`; `100%`; `q?x=1`; `a+b`;
  `it's`; `Grüße/日本語/ключ.txt`; a key of 1024 bytes in segments of at most 255 bytes; a key of
  exactly 255 bytes in one segment.
- Refused as writable: the empty string; `/a`; `a/`; `a//b`; `./a`; `a/../b`; `..`; `a\b`; a key
  holding `U+0000`; a key holding `U+001F`; a key holding `U+007F`; a key of 1025 bytes.
- Refused as addressable: the empty string; `/a`; `a//b`; `./a`; `a/../b`; `.`; a key holding
  `U+0000`.
- Accepted as addressable and refused as writable: `a/`; `a\b`; a key of 1025 bytes.

Accepted means the core's check passes and the request goes out. A provider may still refuse an
addressable key it cannot hold: S3 answers a key above 1024 bytes with `KeyTooLongError`, which
`adapter-s3` reports as `InvalidKey`, and `adapter-azure-blob` reports Azure's `400` for a name
above 1,024 characters the same way. The accepted list holds on Azure unchanged. `adapter-fs` refuses the key of 1024 bytes where the file
system's path limit does not hold it below the root, which section 6 states.

## 10. Versions

- The six packages carry one version and are released together.
- Below 1.0, a patch release repairs code that disagrees with this document. Every other release
  is a minor, whether it adds a promise or withdraws one. A changeset for a change that takes
  something from a caller starts with `**Breaking:**`.
- What a caller may rely on is what this document states. A change only the compiler sees counts
  like a change in behavior, with one exception: a name added to `StorageErrorCode` or
  `capabilityNames` is a minor release, before and after 1.0. A `switch` over either needs a
  default branch.
- The defaults this document declares movable, the backoff numbers of sections 7.5 and 8.5 and the
  upload numbers of sections 7.6 and 8.6, move in a minor release and never in a patch.
- A new conformance case is a minor release. A patch may repair a case and may not add one. A new
  required member on `ConformanceTarget` is breaking; a new optional one is not.
- Tightening a key rule is a minor release below 1.0 and a major above it. Loosening one is neither.
- A provider promised later does not narrow the parity core: what it cannot hold becomes a
  capability its adapter does not declare. Where a difference refuses that shape, as a batch size
  does, the change names its conflict with ADR 0017 and is a withdrawal like any other.
- Dropping a runtime or a Node line that reached end of life leads the changelog entry and is not
  a breaking change, before or after 1.0.
- Nothing is deprecated before it is removed below 1.0. There is no pre-release channel.
- 1.0 promises that a breaking change costs a major release and that a minor marks with
  `@deprecated` what a later major removes. It promises no support window and no fixes for an older
  line. `SECURITY.md` states how to report a vulnerability and that a fix lands in the current line
  alone.
- 1.0 waits for the points of section 13, for a shape for the `raw` escape hatch, and for the author
  having used stowage in a project of their own.

## 11. Documentation

Seven READMEs point into this document. A README states no promise of its own; a line in a README
that disagrees with this document is corrected without a changeset.

- The repository root README shows the package family and opens with two blocks: the same four
  calls, `put`, `get`, `list` and `delete`, against `fsStorage` and against `s3Storage`, differing
  only in how the storage is constructed. Reference flow 1 follows as the second example.
- `@stowage/core`, `@stowage/adapter-memory`, `@stowage/adapter-fs`, `@stowage/adapter-s3` and
  `@stowage/adapter-azure-blob` carry the sections install, example, runtimes, limits and notes, in
  that order, then the link into this document at the tag of their release. An empty section says
  that it is empty.
  - Runtimes: what the package declares, the Bun and Deno versions CI last ran green, the measured
    bundle size.
  - Limits: the capabilities the package does not declare, each beside a link into section 4.9;
    for `adapter-fs` the 255-byte segment, NFD on APFS and the derived content type of section 6;
    for `adapter-s3` the R2 normalization to NFC and the rows of section 7.2; for
    `adapter-azure-blob` the missing `userMetadataTokenKeys`, the three refused kinds of writable
    key and the batch of 256 of section 8.1, and the rows of section 8.2.
  - Notes, what a caller writes themselves: for `adapter-s3` how a connection URL is split into
    `bucket`, `region`, `endpoint` and `credentials`; for every adapter `blob.stream()` for a caller
    holding a `Blob`, and a byte counter written as a `TransformStream` in front of `put`.
  - For `adapter-azure-blob` the example is written with an access token, and the notes lead with
    it: the few lines that wrap an `@azure/identity` credential's `getToken` in a resolver, then the
    account key with Microsoft's advice against it beside it, how a connection string is split into
    `account`, `endpoint` and `credentials`, the CORS rule flow 2 needs, and that
    `InvalidBlockList` on a commit usually means that another writer won.
- `@stowage/conformance` has a shape of its own: how to write a `ConformanceTarget`, how the
  declaration on the storage is filled, how the cases reach Vitest, `bun:test` and `Deno.test`
  through `describeConformance`, what `runAll` is for on `workerd`, and `adapter-memory` as the
  implementation to read.
- Every `ts` block in a README and in this document compiles against the built declarations in
  this repository's tests. Links are not checked.
- TSDoc is written where a meaning was decided: the ten error codes, the five capability names,
  `retry`, `multipart`, `expiresIn`, `contentLength` on `presignPut`, the two forms of
  `AzureBlobCredentials`, `headers` on `PresignedPut`, and every field whose bounds this document
  fixes.
- There is no documentation site, no `examples/` workspace, no `CODE_OF_CONDUCT.md` and no issue
  template. The reference flows exist as the prose of section 3 and the cases of section 9.6.

## 12. Non-goals

v0.2 does not have, and does not promise a path to:

- A GCS adapter. It arrives in its own version with its own ADR.
- Bucket and container management: creating, listing or deleting them.
- A connection URL, a connection string or any other configuration string, in any package.
- Credential providers beyond static credentials, an access token the caller's resolver obtained,
  and `fromEnv`: no IMDS, no web identity, no managed identity, no chain, no bridge to
  `@aws-sdk/credential-providers`, `@azure/identity` or `google-auth-library`.
- A SAS token as a credential.
- Anonymous or unsigned requests.
- Presigned `POST` policies, presigned multipart uploads and presigned block uploads.
- Conditional operations, versioning, object lock, tagging, storage classes, ACLs, server-managed
  encryption and `x-amz-checksum-*` headers; on Azure Blob, append and page blobs, access tiers,
  snapshots, soft delete, leases, immutability policies and blob index tags.
- Accounts with hierarchical namespace and sovereign clouds as promised targets.
- Chunked signing, a per-runtime hasher, and any option to skip payload signing on a request the
  adapter sends.
- Progress reporting, an upload id, and resuming an upload or a download.
- Cleaning up multipart uploads a dead process left behind, and the uncommitted blocks a failed
  upload leaves on Azure Blob.
- A fallback for `copy` above the provider's single-request limit: neither `UploadPartCopy` nor
  blocks copied by range, and no `Copy Blob` that may stay pending.
- A cache of user delegation keys.
- A migration helper that moves a prefix between two storages with concurrency and resume.
- Clock skew correction against the provider's `Date` header.
- A timeout per request attempt.
- A `raw` escape hatch below the concrete adapter type.
- Framework integrations, consumer providers such as Dropbox or WebDAV, a documentation site, a
  registry of conforming adapters, and monetization of any kind.
- Windows as a platform for `adapter-fs`, and hosts as promised targets.

## 13. Settled by the first run

The following are promised here and have not yet been observed against a real endpoint. A promise
a scheduled run disproves is withdrawn in a minor release. The first run, against AWS S3 and R2 on
Node and `workerd`, disproved none of the points it settled; they are stated in the sections they
belong to.

- R2 answers `ExpiredRequest` for an expired credential; the `Expired` case is skipped against R2
  until a way to provoke it exists.

The first run of `adapter-s3` after v0.2 settles, against AWS S3 and R2:

- A `DELETE` of a key holding `U+FFFE` answers `204` and removes the object. Where a provider
  refuses it, no route deletes such a key there, and `adapter-s3` refuses `U+FFFE` and `U+FFFF` in
  a writable key while `list/noncharacter-key` narrows to the listing for S3 (ADR 0027).
- Whether a `DeleteObjects` body holding `&#xFFFE;` or `&#65534;` deletes the object on both. If one
  spelling does, these keys go back into the batch without a change to this document.
- How the multipart answers and `<Deleted><Key>` spell such a key, how R2 encodes a space under
  `encoding-type=url`, and whether R2's continuation token is ASCII. These are recorded only.

The first run of `adapter-azure-blob` against the account settles:

- Whether an NFC and an NFD name are one blob or two, and so whether `keyBytesPreserved` can be
  declared, which would add a promise in a minor release.
- That a writable key holding `U+FFFE` is stored and listed as written, and whether the three kinds
  of writable key section 8.1 refuses need refusing. A refusal shown needless is loosened.
- That `Put Blob From URL` copies the user metadata by default, that the bearer header authorizes
  the source under an access token, and that the service SAS does under an account key; and which
  code the `409` for a source above 5,000 MiB carries, which then joins the table of section 8.8.
- That the three response overrides on `presignGet` are answered as the response headers, which
  Azurite applies to any `GET` and so cannot show.
- That a `Put Block List` sent twice answers `201` both times with the same bytes, and that a
  `Put Blob` discards the uncommitted blocks of its name.
- Which code Azure answers for a `marker` it no longer continues from, and for a name above 1,024
  characters on a `HEAD`.
- How long and how much CPU the 17 MiB upload of flow 1 takes on `workerd`. A result beyond a paid
  plan's limit changes the host note of section 2 and no cell.
