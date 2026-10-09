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
| `@stowage/adapter-gcs`        | A storage in one bucket of Google Cloud Storage                 | Node, Bun, Deno, `workerd` |
| `@stowage/http`               | The HTTP layer and the Node bridge                              | Node, Bun, Deno, `workerd` |
| `@stowage/nestjs`             | The integration for NestJS 12                                   | Node                       |
| `@stowage/hono`               | The integration for Hono 4                                      | Node, Bun, Deno, `workerd` |
| `@stowage/nextjs`             | The integration for Next.js 16                                  | Node                       |
| `@stowage/conformance`        | The cases every adapter and every server has to pass            | Node, Bun, Deno, `workerd` |

- The eleven packages carry one version number and are released together (ADR 0008, ADR 0019,
  ADR 0031, ADR 0046, ADR 0047).
- Every package is published as ESM only. No package has a runtime dependency outside `@stowage/*`.
  An integration declares its framework as a peer dependency and nothing else (ADR 0003, ADR 0008,
  ADR 0019, ADR 0031, ADR 0047).
- An integration promises its framework's current major at its release and the runtimes its
  framework promises, within the four above: NestJS 12 on Node, Hono 4 on all four, Next.js 16 on
  Node. Its peer range starts at the version CI ran at the release (section 2, ADR 0047, ADR 0050).
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

A cell is supported where the conformance suite covers it in CI, and a server's cell where the HTTP
conformance suite does (section 14.8). There is no weaker level (ADR 0002, ADR 0050).

|                                                          | Node                                      | Bun                                       | Deno                                      | `workerd`                           |
| -------------------------------------------------------- | ----------------------------------------- | ----------------------------------------- | ----------------------------------------- | ----------------------------------- |
| 1 large upload from a server                             | yes                                       | yes                                       | yes                                       | yes                                 |
| 2 browser upload through a presigned `PUT`               | yes                                       | yes                                       | yes                                       | yes                                 |
| 3 file browser listing one prefix                        | yes                                       | yes                                       | yes                                       | yes                                 |
| 4 streaming download from an edge runtime                | yes                                       | yes                                       | yes                                       | yes                                 |
| 5 move a prefix from the file system to a cloud provider | yes                                       | yes                                       | yes                                       | no                                  |
| adapters covered in CI                                   | `memory`, `fs`, `s3`, `azure-blob`, `gcs` | `memory`, `fs`, `s3`, `azure-blob`, `gcs` | `memory`, `fs`, `s3`, `azure-blob`, `gcs` | `memory`, `s3`, `azure-blob`, `gcs` |

- CI runs Node 24 and Node 26.
- The `fast` tier of the conformance suite runs on every pull request against SeaweedFS for
  `adapter-s3`, against Azurite for `adapter-azure-blob` and against fake-gcs-server for
  `adapter-gcs`, each pinned by image digest. The `slow` tier runs on a schedule, on demand and
  before every release; on Node and `workerd` it runs against a real AWS S3 bucket, a real R2
  bucket, a real Azure Blob Storage account and a real GCS bucket, on Bun and Deno against the
  emulators (ADR 0012, ADR 0023, ADR 0026, ADR 0034, ADR 0039).
- fake-gcs-server checks no credential and no signature and serves no `moveTo`. Against it the
  credential cases are skipped, and the four rejections of a presigned URL and the three `move`
  cases fail as its divergence list expects; the real bucket answers all of them on Node and
  `workerd`.
  On Bun and Deno the emulator answers the rest of the suite, as SeaweedFS and Azurite do (ADR
  0034, ADR 0039).
- `adapter-fs` is covered on the file systems of Linux and of macOS (section 6). On macOS the
  suite runs without the endpoint tiers (ADR 0012): the `fast` tier on every pull request, both
  tiers wherever the `slow` tier runs.
- On `workerd` the whole suite runs under `no_nodejs_compat` and `no_nodejs_compat_v2`, and the
  `fast` tier runs a second time under the date's default flags.
- Hosts such as Cloudflare's network, Deno Deploy or AWS Lambda are not named in the matrix and
  not promised.
- Flow 1 on `workerd` is promised for the runtime and on no host. The first scheduled run measured
  a 17 MiB upload to S3 at about five seconds and under a second of CPU for the whole `workerd`
  process. The first run against the Azure account measured the same upload to Azure Blob at 6.4
  seconds and half a second of CPU, one token exchange included, and the first run against the
  bucket the same upload to GCS at 8.8 seconds and half a second of CPU, the exchanges at STS and
  IAM Credentials included. Cloudflare's paid plans allow all three by default, and its free plan's
  10 milliseconds allow none.

The servers, each against the runtimes its package promises (section 1):

|                              | Node | Bun | Deno | `workerd` |
| ---------------------------- | ---- | --- | ---- | --------- |
| `@stowage/http`              | yes  | yes | yes  | yes       |
| the Node bridge              | yes  | yes | yes  | no        |
| `@stowage/nestjs` on Express | yes  | no  | no   | no        |
| `@stowage/nestjs` on Fastify | yes  | no  | no   | no        |
| `@stowage/hono`              | yes  | yes | yes  | yes       |
| `@stowage/nextjs`            | yes  | no  | no   | no        |

- Every cell runs a real server over a socket: `@stowage/http` alone on `Bun.serve`, `Deno.serve`
  and `workerd`'s `fetch`, and on Node through the bridge; the bridge on `node:http`'s
  `createServer` on Node, Bun and Deno; Hono on `@hono/node-server`, `Bun.serve`, `Deno.serve` and
  `workerd`; NestJS through `app.listen` on each platform; Next.js through `next build` and
  `next start`. A framework's test utilities, such as `app.request`, `supertest` or
  `Test.createTestingModule`, cover no cell (ADR 0050).
- On Node, Bun and Deno the server and the cases share one process under that runtime's harness.
  For `workerd` and `next start` the Node harness starts the server as a child process.
- Behind every server is `adapter-s3` against SeaweedFS. No other emulator and no real endpoint
  runs behind a server, since an integration adds no provider behavior.
- Every case of the HTTP conformance suite is `fast` and runs on every pull request. On `workerd`
  it runs under `no_nodejs_compat` and `no_nodejs_compat_v2`, and a second time under the date's
  default flags.
- A cell also carries the two repository tests of section 14.8 that no client observes: a client
  disconnecting cancels the stream `get` returned and reaches the provider, on every runtime of the
  cell, and memory stays flat through an upload and a download, on Node. A cell failing the
  disconnect test carries no "yes".
- Runtimes' own servers change an answer of the layer on its way to the socket, which a client of
  the cell sees: `workerd` sends every body that is a stream chunked and without `Content-Length`,
  a `200` and a `206` among them, and `Bun.serve` does the same to a body still streaming when the
  headers are written, while it keeps the length of one that is complete by then, a small object's
  among them. A list beside each server in the private harness names each change a case meets: in
  `serve/whole`, `serve/head` and `serve/range` on `workerd` the harness undoes it on that server's
  answers, so that the rest of the case runs, and fails the run where the case meets no changed
  answer (ADR 0064). `Bun.serve` and `Deno.serve` add `Content-Length: 0` to a `HEAD` answered
  without a length, which the layer does for a content-coded object alone (section 10.3).
- CI runs the floor and the newest release of each framework's major on Node 24 and Node 26. The
  floors are `@nestjs/common`, `@nestjs/core`, `@nestjs/platform-express` and
  `@nestjs/platform-fastify` 12.1.2, `hono` 4.13.12 on `@hono/node-server` 2.1.3, and `next`
  16.3.8. A peer range starts at its floor: `^12.1.2`, `^4.13.12`, `^16.3.8`. The newest release
  moves with the framework, and each integration's README names the one CI ran at its release.
- Express and Fastify without NestJS reach stowage through the Node bridge and are not named as
  frameworks (ADR 0046). Bun and Deno under NestJS or Next.js are not promised, as their frameworks
  promise neither.

## 3. Reference flows

The five call sequences stowage is designed for. Each names its adapters and runtimes, what has to
hold for it to count as supported, and the failures it has to tell apart. The conformance suite
carries one case per flow (section 14.6).

### Flow 1: large upload from a server

A server process writes a stream of unknown length under a key.

- In: key, `ReadableStream<Uint8Array>`, optional content type, content headers and user
  metadata.
- Out: the stored object's description.
- Adapters: `memory`, `fs`, `s3`, `azure-blob`, `gcs`. Runtimes: Node, Bun, Deno, `workerd`.
- Holds when: memory does not grow with the size of the object (`adapter-memory` excepted); the
  object reads back byte for byte; after an upload that fails partway or is aborted, the key is
  absent or holds what it held before. What such an upload leaves with the provider is stated per
  adapter: nothing on S3 except in the one case section 7.7 names (section 7.6), its staged blocks
  on Azure Blob (section 8.6), and on GCS nothing the API shows, except a session whose cancel did
  not arrive, which holds its bytes for up to a week (section 9.6).
- Fails as: the caller aborts (`AbortError`); the credential expires during the upload (`Expired`,
  or `InvalidCredentials` where the provider or the adapter cannot tell an expiry, on R2, Azure
  Blob and GCS, sections 7.2, 8.3 and 9.3; on GCS a
  credential expiring after the upload started does not fail it, since its chunks carry none); the
  provider rejects the write (`AccessDenied`, `InvalidRequest`, `ProviderError`).
- Through a route: `acceptUpload` of `@stowage/http` streams a request body into `put` with a size
  limit (section 10.5).

### Flow 2: browser upload through a presigned `PUT`

A server signs a URL and the browser uploads to the provider directly.

- In: key, lifetime, content type, the content length the client reported, and optionally the
  content headers the object is stored with.
- Out: a URL and the headers a plain `fetch` sends with `PUT` beside the body.
- Adapters: `s3`, `azure-blob`, `gcs`. Runtimes: the signing side on Node, Bun, Deno and
  `workerd`.
- Holds when: content type, content length and each content header given are bound through signed
  headers, so the provider rejects an upload that deviates from any of them; the binding is exact
  up to runs of spaces, which the provider stores as sent, and a body of unknown length cannot be
  uploaded through the URL; an expired URL is rejected; the rejections reach the client as an HTTP
  status. A content header the URL does not bind can be set by whoever holds the URL, and the
  provider stores it (ADR 0063).
- Fails as: signature mismatch, expired URL, a body that contradicts the signed headers. The
  provider answers the browser, so none of them reaches the adapter or becomes a `StorageError`.
- Requires, on `s3`: the bucket policy allows `UNSIGNED-PAYLOAD`, and CORS is configured for the
  origin that uploads, allowing `cache-control`, `content-disposition` and `content-language` where
  the URL binds them. On `azure-blob`: the account's CORS rule allows the origin, `PUT`, and the
  headers `content-type`, `x-ms-blob-type` and `x-ms-blob-content-type`, and
  `x-ms-blob-cache-control`, `x-ms-blob-content-disposition` and `x-ms-blob-content-language` where
  the URL binds them, and the signing storage is built with an access token (section 8.9). On
  `gcs`: the storage is built with a `signer`, and the bucket's CORS rule allows the origin, `PUT`
  and the header `content-type`, and `cache-control`, `content-disposition` and `content-language`
  where the URL binds them (section 9.9). The rule names `content-language` although CORS
  safelists it, since it does so only for a short value of a restricted alphabet. stowage states
  these and configures none of them.
- Every cross-origin upload through the URL is preflighted, because `PUT` is not a CORS-safelisted
  method. Azure Blob and GCS answer a rejected upload with the CORS headers of the rule, so a page
  reads its status and not the provider's code; R2 sends none on the `403` for an expired URL, so a
  page sees a network error there. GCS answers an expired URL with `400`, the others with `403`.
- Carries no integrity check: no provider signs a hash or a checksum of the body into the URL.
- Through a route: `presignUpload` of `@stowage/http` answers with the URL and its headers
  (section 10.6).

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
- Out: a `ReadableStream<Uint8Array>`, the content type and the content headers for the response
  headers, and for a range the partial content.
- Adapters: `s3`, `azure-blob`, `gcs`. Runtimes: all four.
- Holds when: nothing is buffered, so memory stays flat for an object of any size; a range returns
  partial content; the client disconnecting cancels the stream and reaches the provider.
- Fails as: missing key (`NotFound`); range not satisfiable (`InvalidRequest`); a range on an
  object another tool stored with a content coding (`ProviderError`, section 4.3).
- Through a route: `serveObject` of `@stowage/http` answers the `GET` from `get` and passes its
  `Range` on (section 10.3); `redirectToObject` instead hands the range to the provider through a
  presigned `GET` (section 10.4).

### Flow 5: move a prefix from the file system to a cloud provider

A one-off script moves everything below a prefix to another provider.

- In: source storage and prefix, target storage and prefix.
- Out: what moved, and the failures per object.
- Adapters: `fs` to `s3`, `azure-blob` or `gcs`, and any other pair. Runtimes: Node, Bun, Deno.
- Holds when: the stream out of `get` goes into `put` without the object being held whole anywhere;
  the content type survives the move where the target stores one (section 6 for where `adapter-fs`
  does not); `deleteAll(prefix)` pages and batches on its own and reports what it could not delete.
  An object read from `adapter-fs` carries no content headers, so none reach the target; a caller
  moving the other way who hands `put` the content headers `stat` reported is refused by
  `adapter-fs`, as with user metadata (ADR 0060).
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
- Nothing lies below an adapter's concrete type: storage objects expose no requests, signers,
  credentials, or request hooks. Adapter packages may export credential types and resolvers;
  `@stowage/core` exports no adapter-specific request, signer, or credential. A caller who needs to
  send a request that stowage does not send signs it with code of their own, such as aws4fetch using
  the same access key (ADR 0042).
- `provider` names the adapter: `"memory"`, `"fs"`, `"s3"`, `"azure-blob"` or `"gcs"`. `bucket`
  names the namespace the storage is bound to (sections 5 to 9 say what that is per adapter).
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
  stream is sent in parts once it fills more than one (sections 7.6, 8.6 and 9.6 for the numbers).
  No adapter hands `fetch` a body stream of unknown length.

### 4.3 Options

```ts
export interface OperationOptions {
  signal?: AbortSignal;
}

export interface PutOptions extends OperationOptions {
  contentType?: string;
  cacheControl?: string;
  contentDisposition?: string;
  contentLanguage?: string;
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
- `contentType` absent: `adapter-memory`, `adapter-s3`, `adapter-azure-blob` and `adapter-gcs`
  store `application/octet-stream`; `adapter-fs` derives the type from the key (section 6).
- `cacheControl`, `contentDisposition` and `contentLanguage`, the content headers, are stored as
  `Cache-Control`, `Content-Disposition` and `Content-Language` where the storage declares
  `contentHeaders`, and read back as written (section 4.4). Nothing parses them: `max-age=abc` and
  `attachment; filename=` are stored as sent. A file name outside ASCII travels as RFC 8187's
  `filename*=UTF-8''…`, which the caller encodes. A `put` that carries at least one of them, as a
  value other than `undefined`, is checked in this order, each before signing and with
  `attempts: 0` (ADR 0058, ADR 0060):
  1. Where the storage does not declare `contentHeaders`, it is `Unsupported` naming
     `contentHeaders`, whatever the value.
  2. A value that is no string, is empty, or holds anything but visible ASCII with spaces and tabs
     inside it, is `InvalidOption` naming the option and never its value. A space or a tab at
     either end is refused, since `fetch` trims it.
  3. The header names and values of `Content-Type` and of the content headers the `put` carries
     hold at most 2,048 bytes together, `Content-Type` counted with the type as given or as
     `application/octet-stream` where absent; more is `InvalidRequest`.
  4. A `contentLanguage` of more than 100 characters is `InvalidRequest`.

  A `put` that carries none of the three is not measured, whatever its `contentType`. Across
  `contentType`, `userMetadata` and the content headers no order is promised.

- `userMetadata` is stored where the storage declares `userMetadata`. Keys are compared
  case-insensitively. Values may hold any Unicode character; a value that would not travel in a
  header as written is RFC 2047-encoded where an adapter sends it in a header, and `adapter-gcs`
  sends every value as written (section 9.4). A `userMetadata` with at least one entry is checked
  in this order, each before signing and with `attempts: 0`:
  1. Where the storage does not declare `userMetadata`, it is `Unsupported` naming `userMetadata`.
     `undefined` and `{}` pass on every storage.
  2. A key that is not a non-empty ASCII HTTP token, including one holding a space, control,
     colon, slash, question mark or bracket, is `InvalidRequest`, and so are two keys that differ
     in case alone.
  3. A value holding a lone surrogate is `InvalidRequest`: it has no UTF-8 form for the bound below
     to measure, and an encoder would send `U+FFFD` in its place.
  4. Keys and values together hold at most 2 KB, measured as the header bytes the encoding of
     section 4.13 produces, whatever an adapter encodes beyond it; more is `InvalidRequest`.
  5. Where the storage does not declare `userMetadataTokenKeys`, a key that is not an ASCII
     identifier, `[A-Za-z_][A-Za-z0-9_]*`, such as `content-hash`, `x.y` or `1st`, is
     `Unsupported` naming `userMetadataTokenKeys` (ADR 0020).
- `range` is honored where the storage declares `rangeReads` and is `Unsupported` elsewhere. `start`
  and `end` are non-negative integers with `start <= end`; anything else is `InvalidOption`. A
  `start` at or beyond the object's size is `InvalidRequest`. An `end` beyond the size is clipped.
- An object another tool stored with a content coding takes no range. Where the answer to a ranged
  `get` names a `Content-Encoding` other than `identity`, in any case, the adapter cancels the body
  and rejects with `ProviderError` naming the coding, also where the range covers the whole object.
  A `start` at or beyond the stored size of such an object stays `InvalidRequest` on `adapter-s3`
  and `adapter-azure-blob`, whose provider answers it without naming the coding, and is
  `ProviderError` on `adapter-gcs` (section 9.4, ADR 0040, ADR 0044).
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
  readonly cacheControl?: string;
  readonly contentDisposition?: string;
  readonly contentLanguage?: string;
  readonly contentEncoding?: string;
  readonly userMetadata: Readonly<Record<string, string>>;
}
```

- `put`, `stat`, `copy`, `move` and `get` produce an `ObjectStat`. A listing yields `ObjectEntry`,
  because a listing response carries neither content type, content headers nor metadata.
- `size` counts the bytes the storage holds. After `put` it is the number of bytes written; after
  a ranged `get` it is the size of the whole object, not of the range. An object whose
  `contentEncoding` is set may arrive decoded and longer than `size`, or as stored, depending
  on the runtime and the adapter: Node, Bun and `workerd` decode the codings they know, and Deno
  decodes none on `adapter-s3` and `adapter-azure-blob`, whose requests carry
  `accept-encoding: identity`. stowage never writes such an object (ADR 0040, ADR 0044).
- `cacheControl`, `contentDisposition` and `contentLanguage` are the content headers as stored,
  byte for byte and decoded in no way. A member is missing where the object holds no value or an
  empty one, never present as `undefined`, and all three are missing where the storage does not
  declare `contentHeaders`. Reading never refuses: a value another tool stored outside the rule of
  section 4.3, UTF-8 or longer than its bounds, is reported as read. The `ObjectStat` that `put`,
  `copy` and `move` resolve with carries the values a later `stat` reports (ADR 0058).
- `contentEncoding` names the content coding the object is stored with, as stored, such as `GZIP`
  or `gzip, br`; RFC 9110 makes its tokens case-insensitive, so a caller lower-cases before
  comparing. It is missing where the object holds no coding, an empty value or `identity` in any
  case, so it is set exactly where section 4.3 refuses a range. It names how the object is stored,
  not which bytes arrive. `put` never reports one, since stowage writes none; `copy` and `move`
  report the source's. `adapter-memory` and `adapter-fs` never report one, and no capability is
  involved (ADR 0061).
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

- `stat` describes the object whose bytes the body carries. What `get` costs is stated per
  adapter: one request on `adapter-s3` and `adapter-azure-blob`, two sent side by side on
  `adapter-gcs`, and at most two more, one after the other, where a writer replaced the object
  between them (section 9.4, ADR 0032, ADR 0040).
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

| Rule          | Applies to                                                                       | Requirements                                                                                                                                                                                   |
| ------------- | -------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `writable`    | `put`, the `to` of `copy` and `move`, `presignPut`                               | 1 to 1024 bytes; no `.` or `..` as a segment; no leading `/`; no empty segment (`//`); no trailing `/`; no backslash; no character in `U+0000` to `U+001F` and no `U+007F`; no lone surrogate  |
| `addressable` | `get`, `stat`, `exists`, `delete`, the `from` of `copy` and `move`, `presignGet` | At least 1 byte; no `.` or `..` as a segment; no leading `/`; no empty segment; no control character; no lone surrogate. A trailing `/`, a backslash and a length above 1024 bytes are allowed |
| `prefix`      | `list`, `deleteAll`                                                              | The `addressable` rule, so no lone surrogate either, except that it may be empty, may end in `/`, and may end in the middle of a segment                                                       |

- There is no allowlist. `#`, `%`, `?`, `+`, a space, `'` and every character above ASCII are legal.
  An adapter encodes a key itself and never builds a request path through the `URL` constructor.
- A lone surrogate, which a JavaScript string can hold, is no Unicode character and has no UTF-8
  form, so every rule refuses it: an encoder would rewrite it or fail on it, and no provider holds
  it.
- Nothing normalizes the Unicode form. Two keys that are equivalent under Unicode without being
  equal byte for byte may name one object or two, depending on the provider. A storage that
  declares `keyBytesPreserved` returns every key byte for byte as it was written; the others
  return a Unicode-equivalent key.
- An adapter may refuse more than the rule above and reports that as `InvalidKey` too; `adapter-fs`
  refuses a segment longer than 255 bytes and any name the file system refuses (section 6),
  `adapter-azure-blob` three kinds of writable key (section 8.1), `adapter-gcs` two (section 9.1).
  `adapter-memory` enforces the rule exactly.
- A violation is `InvalidKey` with `attempts: 0`. `copy` and `move` check both keys before acting
  on either. `delete` reports an invalid key in `failed`.
- An empty prefix on `deleteAll` deletes every object in the storage.

### 4.9 Capabilities

```ts
export const capabilityNames = [
  "contentHeaders",
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
| `contentHeaders`        | `put` stores the content headers; `stat` and `get` return them; `copy` and `move` keep them         | `put` with any of the three is `Unsupported`; reads report none                                                         |
| `keyBytesPreserved`     | A key comes back byte for byte as written                                                           | A key comes back Unicode-equivalent                                                                                     |
| `presignedUrls`         | The concrete type carries `presignGet` and `presignPut`                                             | Neither method exists on the type                                                                                       |
| `rangeReads`            | `get` honors `range`                                                                                | `get` with `range` is `Unsupported`                                                                                     |
| `userMetadata`          | `put` stores `userMetadata` with ASCII identifier keys; `stat` and `get` return it; `copy` keeps it | `put` with a non-empty `userMetadata` is `Unsupported`; reads return `{}`                                               |
| `userMetadataTokenKeys` | Beside `userMetadata`: a key may be any ASCII HTTP token, such as `content-hash`                    | A key outside identifiers is `Unsupported` naming it; without `userMetadata` too, the call is `Unsupported` naming that |

- The declarations: `adapter-s3` `contentHeaders`, `presignedUrls`, `rangeReads`, `userMetadata`,
  `userMetadataTokenKeys`; `adapter-azure-blob` `contentHeaders`, `keyBytesPreserved`,
  `presignedUrls`, `rangeReads`, `userMetadata`; `adapter-gcs` `contentHeaders`,
  `keyBytesPreserved`, `rangeReads`, `userMetadata`, `userMetadataTokenKeys`, and `presignedUrls`
  where the storage is built with a `signer` (section 9.1); `adapter-fs` `rangeReads`;
  `adapter-memory` `contentHeaders`, `keyBytesPreserved`, `rangeReads`, `userMetadata`,
  `userMetadataTokenKeys`.
- The declaration is runtime only. There is no type parameter over it. `gcsStorage` is overloaded
  on `signer`, the option that decides its `presignedUrls`, so the type it returns carries the two
  methods where the storage declares the capability (section 9.1, ADR 0035).
- An `Unsupported` error names the capability in its `capability` field.
- The list is closed and grows in minor releases (section 15).

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

| Code                 | Meaning                                                                                                                                                                                                                                                          |
| -------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `NotFound`           | No object under the key, or, without `key`, no bucket (**A missing bucket** below)                                                                                                                                                                               |
| `AccessDenied`       | The credential is valid and may not do this                                                                                                                                                                                                                      |
| `InvalidCredentials` | The provider does not accept the credential, or a required credential field is empty or unknown                                                                                                                                                                  |
| `Expired`            | The credential or session token has expired                                                                                                                                                                                                                      |
| `InvalidRequest`     | The provider or stowage refused the request for what it asked: metadata or content headers over the limit, an unsatisfiable range, a copy onto itself, a second read of a body, a request timestamp the provider refused where it names that apart (section 8.8) |
| `NetworkError`       | The request received no response: DNS, connection, TLS, a broken connection                                                                                                                                                                                      |
| `ProviderError`      | The provider answered with a failure stowage has no other name for; `providerCode` carries its string                                                                                                                                                            |
| `InvalidKey`         | The key violates the rule of section 4.8, or a rule the adapter adds to it                                                                                                                                                                                       |
| `InvalidOption`      | An option or configuration value stowage refused: an unknown key, a value out of range, a cursor it did not produce                                                                                                                                              |
| `Unsupported`        | The call needs a capability the storage does not declare; `capability` names it                                                                                                                                                                                  |

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

**Mapping from an HTTP status.** An adapter maps a recognized provider code first (sections 7.9,
8.8 and 9.8).
Where none is recognized, the status decides: `401` is `InvalidCredentials`, `403` is
`AccessDenied`, `404` is `NotFound`, except on the paths where `adapter-gcs` reads a `404` as
absence only with its provider code (section 9.8). `408`, `429` and every `5xx` are `ProviderError` with
`retryable: true`. Any other status is `ProviderError` with `retryable: false`.

**Absence.** `get` and `stat` on a missing key reject with `NotFound`. `exists` answers `false` for
a `NotFound` that carries `key` alone and rethrows every other failure, including the `403` that S3
answers for a missing key under a credential without `s3:ListBucket`. Deleting a missing key
succeeds.

**A missing bucket.** An operation against a bucket that does not exist rejects, on every adapter:
`exists` never answers `false` for it, and `delete` and `deleteAll` reject rather than report.
Where the provider names the bucket as missing, the error is `NotFound` without `key`: S3's
`NoSuchBucket` (section 7.9), Azure's `ContainerNotFound` (section 8.4), the missing bucket of GCS
(section 9.8) and a root of `adapter-fs` that does not exist (section 6). R2 under a token scoped to
other buckets answers `AccessDenied` instead (section 7.2). `adapter-memory` has no bucket to miss
(ADR 0043).

**Abort.** A fired `AbortSignal` produces the runtime's `AbortError`, never a `StorageError`.
Callers handle two shapes: `isStorageError(err)` and `err.name === "AbortError"`.

**After the promise resolved.** A body stream that breaks partway through `get` and a page that
fails during a `list` iteration arrive as `StorageError` as well.

**Compound operations.** `move` throws the error of the step that failed. When the delete fails,
the destination stays in place and repeating the `move` is safe.

### 4.11 Operations

| Operation   | Key rule                              | Does                                                                                                                                                                                  | Rejects with                                                                                                                |
| ----------- | ------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------- |
| `put`       | `writable`                            | Stores the body under the key, replacing any object there. Resolves once the object is readable under the key                                                                         | `InvalidKey`, `InvalidOption`, `InvalidRequest`, `Unsupported`, provider failures                                           |
| `get`       | `addressable`                         | Returns the object's description and a body readable once                                                                                                                             | `NotFound`, `Unsupported` (range), `InvalidRequest` (range), `ProviderError` (range on a content-coded object, section 4.3) |
| `stat`      | `addressable`                         | Returns the object's description without its body                                                                                                                                     | `NotFound`                                                                                                                  |
| `exists`    | `addressable`                         | `true` where `stat` would succeed, `false` where it would reject with `NotFound` for the key                                                                                          | Every other failure `stat` would reject with, a missing bucket among them (section 4.10)                                    |
| `list`      | `prefix`                              | Section 4.6                                                                                                                                                                           | `InvalidOption` (`pageSize`, `cursor`, `delimiter`)                                                                         |
| `delete`    | `addressable` per key                 | Deletes the keys, batching as the provider requires, in no promised order. Zero keys resolves with `requested: 0`                                                                     | A failure of the request as a whole, a missing bucket among them (section 4.10)                                             |
| `deleteAll` | `prefix`                              | Lists every object below the prefix and deletes it, paging and batching on its own. Objects written during the call may or may not be deleted                                         | A failure of the request as a whole, a missing bucket among them (section 4.10)                                             |
| `copy`      | `from` `addressable`, `to` `writable` | Creates `to` with the bytes, content type, content headers, content coding and user metadata of `from`, replacing any object at `to`. `from` stays. `from === to` is `InvalidRequest` | `NotFound`, `InvalidKey`, `InvalidRequest`                                                                                  |
| `move`      | `from` `addressable`, `to` `writable` | The outcome of `copy` then `delete` of `from`, in one request on `adapter-gcs` (section 9.7). Resolves with the description of `to`                                                   | The failure of the step that failed                                                                                         |

- `delimiter` is one or more characters; an empty string is `InvalidOption`.
- `copy` and `move` keep `cacheControl` and `contentDisposition` byte for byte, and
  `contentLanguage` as the same list, with whitespace around its commas possibly removed: Azure
  turns `de-AT, en` into `de-AT,en` (section 8.7). Neither takes an option that replaces them
  (ADR 0058, ADR 0059).
- Nothing in the API is atomic across keys, and no operation is conditional. Of two writers to one
  key, each may resolve or reject, and the key ends with one whole object written by one of them
  (ADR 0024). `adapter-memory`, `adapter-fs`, `adapter-s3` and `adapter-gcs` resolve both.

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

/** A failure the rules of section 4 decide, which an adapter raises as its own `StorageError`. */
export type Refusal =
  | { readonly code: "Unsupported"; readonly message: string; readonly capability: CapabilityName }
  | { readonly code: "InvalidRequest" | "InvalidOption"; readonly message: string };

/** `InvalidOption` naming `range` where the bounds break section 4.3, else `undefined`. */
export function rangeBoundsRefusal(range: ByteRange | undefined): Refusal | undefined;
/** `InvalidRequest` where the range starts at or beyond the object's `size` bytes. */
export function rangeStartRefusal(range: ByteRange, size: number, key: string): Refusal | undefined;
/** The last byte the range names, both ends inclusive, clipped to the object's `size` bytes. */
export function lastByteOf(range: ByteRange | undefined, size: number): number;
/** Whether the whole object is the body the range asks for, clipped as section 4.3 clips it. */
export function rangeCoversWhole(range: ByteRange, size: number): boolean;
/** The `Range` field of RFC 9110, both ends inclusive as `ByteRange` is. */
export function rangeHeader(range: ByteRange): string;
/** The whole object's size out of a `Content-Range` value, or `undefined` where it names none. */
export function wholeSizeOf(contentRange: string | null): number | undefined;
/** `ProviderError` naming the coding where the value names one other than `identity`. */
export function contentCodingRefusal(
  contentEncoding: string | null | undefined,
  key: string,
): { readonly code: "ProviderError"; readonly message: string } | undefined;
/** What `contentEncoding` of `ObjectStat` reports for a stored value, `undefined` for none. */
export function contentEncodingOf(contentEncoding: string | null | undefined): string | undefined;

/** Visible ASCII, with spaces and tabs inside alone: the rule of section 4.3 for a header value. */
export function isHeaderValue(value: string): boolean;
export interface ContentHeaders {
  readonly cacheControl?: string;
  readonly contentDisposition?: string;
  readonly contentLanguage?: string;
}
export type ContentHeadersCheck = { readonly held: ContentHeaders } | { readonly refusal: Refusal };
/** Runs the checks of section 4.3 in order on a frozen snapshot; `held` is what passed. */
export function checkContentHeaders(
  headers: ContentHeaders,
  contentType: string | undefined,
  capabilities: readonly CapabilityName[],
): ContentHeadersCheck;

export type UserMetadataKeyRule = "token" | "identifier";
export function isUserMetadataKey(name: string, rule: UserMetadataKeyRule): boolean;
/** The value as a header carries it: as written where it travels so, else as encoded words. */
export function encodeUserMetadataValue(value: string, options?: { always?: boolean }): string;
/** A header value read back, with every form of encoded word RFC 2047 allows decoded. */
export function decodeUserMetadataValue(value: string): string;
/** What section 4.3 bounds at 2 KB: every key and its value as `encodeUserMetadataValue` writes it. */
export function userMetadataByteLength(userMetadata: Readonly<Record<string, string>>): number;
export type UserMetadataCheck =
  { readonly held: Readonly<Record<string, string>> } | { readonly refusal: Refusal };
/** Runs the checks of section 4.3 in order; `held` has its keys folded to lower case. */
export function checkUserMetadata(
  userMetadata: Record<string, string> | undefined,
  capabilities: readonly CapabilityName[],
): UserMetadataCheck;

export interface PresignedPut {
  readonly url: string;
  /** The headers the client sends beside the body. `Content-Length` is never among them. */
  readonly headers: Readonly<Record<string, string>>;
}

export interface StreamUploadOptions {
  readonly partSize: number;
  readonly concurrency: number;
  /** The provider's limit on the parts of one upload, `Infinity` where it has none. */
  readonly maxParts: number;
  /** What the `InvalidRequest` for a stream above `maxParts` is told against. */
  readonly bucket: string;
  readonly provider: string;
  readonly key: string;
  readonly signal?: AbortSignal;
}
export interface StreamUpload<T> {
  /** The stream ended within the first part: the bytes go as one request. */
  whole(bytes: Uint8Array<ArrayBuffer>): Promise<T>;
  /** The first part filled: the adapter starts, sends through `sendParts`, and commits. */
  multipart(sendParts: SendParts): Promise<T>;
}
export type SendParts = <R>(
  send: (index: number, bytes: Uint8Array<ArrayBuffer>, signal: AbortSignal) => Promise<R>,
) => Promise<{ readonly results: readonly R[]; readonly size: number }>;
export function uploadStream<T>(
  stream: ReadableStream<Uint8Array>,
  options: StreamUploadOptions,
  upload: StreamUpload<T>,
): Promise<T>;

/** A whole HTTP request carried inside a batch, which sends no body of its own. */
export interface BatchSubrequest {
  readonly method: string;
  /** Encoded, as its request line carries it. */
  readonly path: string;
  readonly headers: readonly (readonly [name: string, value: string])[];
}
/** One HTTP response inside the answer, under the `Content-ID` the answer gives it. */
export interface BatchSubresponse {
  readonly contentId: string;
  readonly status: number;
  readonly headers: Headers;
  readonly body: string;
}
/** A fresh boundary for one batch body. */
export function batchBoundary(): string;
/** The `Content-Type` of a batch request: `multipart/mixed` under the boundary. */
export function batchContentType(boundary: string): string;
/** Each subrequest as an `application/http` part, its place in the batch as its `Content-ID`. */
export function batchBody(
  boundary: string,
  subrequests: readonly BatchSubrequest[],
): Uint8Array<ArrayBuffer>;
/** One subresponse per subrequest in their order, or why the answer cannot be read. */
export type SubresponseReading =
  | { readonly subresponses: readonly BatchSubresponse[] }
  | { readonly unreadable: string }
  | { readonly unanswered: number };
/** The answer's subresponses, each paired by the `Content-ID` `echoedContentId` names. */
export function readSubresponses(
  contentType: string | null,
  body: string,
  subrequestCount: number,
  echoedContentId: (sent: string) => string,
): SubresponseReading;
```

- Every adapter calls `invalidKeyReason` as the first act of every operation and rejects with
  `InvalidKey` where it returns a reason.
- `errorCodeForStatus` and `isTransientStatus` are the one definition of the status mapping in
  section 4.10. `withRetry` is the one definition of the retry loop of sections 7.5, 8.5 and 9.5;
  `adapter-fs` and `adapter-memory` do not call it.
- A `StorageError` with code `Unsupported` requires `capability`; the constructor rejects one
  without it.
- A `Refusal` states what a rule of section 4 decides and leaves the error to the adapter, which
  raises it through its own factory with its bucket, the operation, the key and the attempts, as
  `invalidKeyReason` leaves the `InvalidKey` to it.
- Every adapter refuses the bounds `rangeBoundsRefusal` names before the object is looked up, and
  a start `rangeStartRefusal` names once the object's size is known; `adapter-fs` and
  `adapter-memory` read up to `lastByteOf`. `rangeHeader`, `wholeSizeOf` and `rangeCoversWhole`
  are the one definition of a range on the wire: a `200` answering a ranged request is the body
  asked for exactly where `rangeCoversWhole` holds.
- `contentCodingRefusal` and `contentEncodingOf` share the one definition of a coding: an absent or
  empty value and `identity` in any case name none, and every other value names one, kept as
  stored (ADR 0061). `contentCodingRefusal` is the rule of section 4.3 for an object stored with a
  content coding. `adapter-s3`, `adapter-azure-blob` and `adapter-gcs` call it on the answer to
  every ranged `get`, before `rangeCoversWhole`, with the coding their provider names, and cancel
  the body where it refuses, and they set `contentEncoding` of every `ObjectStat` through
  `contentEncodingOf`. `adapter-fs` and `adapter-memory` hold no content coding and call neither.
- `adapter-memory`, `adapter-s3`, `adapter-azure-blob` and `adapter-gcs` run `checkUserMetadata`
  before a `put` writes or sends anything, raise its refusal with `attempts: 0`, and store `held`.
- `checkContentHeaders` is the one definition of the checks of section 4.3 for the content headers.
  It reads each of the three once into a frozen snapshot and checks that, so `held` is what an
  adapter sends, with no member for a header given as `undefined`. Every adapter, `adapter-fs`
  included, runs it before a `put` writes or sends anything, and every adapter that declares
  `presignedUrls` before `presignPut` signs, with the content type the request carries. The adapter
  raises the refusal with `attempts: 0`, and sends or stores `held`. `isHeaderValue` is the form
  that check applies. `@stowage/http` checks the content type of `presignUpload` with
  `isHeaderValue` and its content headers with `checkContentHeaders` under `capabilityNames`, so
  that the form and the bounds alone decide there (section 10.6, ADR 0058, ADR 0063).
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
- `uploadStream` is the one definition of reading a streamed body into parts, used by sections
  7.6, 8.6 and 9.6 (ADR 0030, ADR 0036). A stream that ends within the first part goes to `whole`; any other goes to
  `multipart`, which may call `sendParts` once, and a second call rejects with an `Error`.
  `sendParts` keeps `concurrency` parts in flight and reads the next part only once one settled, so
  the part buffers stay at `partSize × concurrency` (ADR 0016). `send` receives the part's index
  from zero, its bytes, and a signal that fires on the first failure of a part and on the caller's
  abort. `sendParts` settles once every part in flight settled, resolves with the results in part
  order and the bytes sent, and rejects with the first failure.
- A stream above `maxParts` rejects with `InvalidRequest`, `attempts: 0`, told against the options'
  `bucket`, `provider` and `key` and naming the configured `partSize` and a larger
  `multipart.partSize` as the way past it. The part that would be the last one allowed is not sent.
- `uploadStream` cancels the source wherever it settles before the stream ended: when `multipart`
  rejects, when a part fails, on the caller's abort, and when `multipart` returns without calling
  `sendParts`. The part reader is not exported.
- `batchBoundary`, `batchContentType`, `batchBody` and `readSubresponses` are the one definition of
  a `multipart/mixed` batch on the wire: `adapter-azure-blob` sends and reads its Blob Batch
  through them (section 8.4), and `adapter-gcs` its batch requests (section 9.4). A subrequest
  sends no body. The adapter chooses the subrequests' headers, names the form its provider echoes
  a `Content-ID` in, as sent on Azure and as `response-0` on GCS, which reads the form
  fake-gcs-server echoes as well (section 9.4), and maps each subresponse to its outcome.
- `readSubresponses` takes the boundary from `Content-Type`, quoted or bare, and reads lines
  ending in CRLF or LF. An answer that is no `multipart/mixed` of HTTP responses, a `Content-ID`
  that answers no subrequest and two answers to one subrequest are `unreadable`, which names what
  the answer is instead; a subrequest nothing answers is `unanswered`, its place in the batch. An
  adapter reports either as `ProviderError`.

## 5. `@stowage/adapter-memory`

```ts
export interface MemoryStorage extends Storage {
  readonly provider: "memory";
}
export function memoryStorage(): MemoryStorage;
```

- `bucket` is `"memory"`. Two calls to `memoryStorage()` are two storages that share nothing.
- Declares `contentHeaders`, `keyBytesPreserved`, `rangeReads`, `userMetadata` and
  `userMetadataTokenKeys`.
- Keeps the content headers byte for byte through `put`, `stat`, `get`, `copy` and `move`,
  `contentLanguage` on a copy included, which is more than section 4.11 promises. It never reports
  a `contentEncoding` and offers no way to seed one (ADR 0060, ADR 0061).
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
  performs no I/O, and an operation against a root that does not exist rejects with `NotFound`
  without `key` (section 4.10).
- Declares `rangeReads` only. `put` with a non-empty `userMetadata` is `Unsupported`; reads return
  `{}`. `put` with any content header other than `undefined` is `Unsupported` naming
  `contentHeaders`, `""` included; reads report none and no `contentEncoding`. The adapter keeps no
  sidecar file and no extended attribute for either (ADR 0015, ADR 0060).
- A key maps to the path below the root with `/` as the separator. Every access resolves the real
  path and answers `NotFound` where it lies outside the root, so a symbolic link pointing out of the
  root behaves as an absent object.
- Refuses a segment longer than 255 bytes with `InvalidKey`. A key whose whole path passes what the
  file system holds is `InvalidKey` as well, through the `ENAMETOOLONG` of the mapping below: macOS
  bounds one path at 1024 bytes with the root counted in, so the 1024-byte key of section 14.7 is
  written on Linux and refused there.
- A name the file system refuses to create is `InvalidKey` for `put` and for the `to` of `copy` and
  `move`, through the `EILSEQ` of the mapping below. APFS refuses every noncharacter, such as
  `U+FFFE` or `U+FDD0`, in any segment, so a key holding one is written on Linux and refused on
  macOS. The adapter passes the refusal on rather than storing the name in another form (ADR 0010),
  and a read of such a key answers as for an absent object.
- A name that is no UTF-8, which another tool may write on Linux, has no key. A listing or
  `deleteAll` it falls below fails with `ProviderError` naming the name as bytes, as section 4.6 has
  an entry without a key fail, rather than pass over it or list it with `U+FFFD` in its place.
- The content type is derived from the key's extension through a built-in table, and
  `application/octet-stream` where the extension is unknown or absent. The `contentType` handed to
  `put` is validated as a string and not stored, so `stat` may report a type that differs from the
  one given to `put`. The parity core's promise that an object carries a content type is kept
  weakly here; `keyBytesPreserved` is the model, and no capability name exists for it.
- `put` writes to a temporary file in the same directory and renames it into place, so a reader sees
  the old object or the new one and never a partial write. Intermediate directories are created.
  That file carries a name of the adapter's own, which a listing passes over: a write in flight is
  no object, and neither is a key of that shape. A `put`, `copy` or `move` that fails removes the
  directories it created where they stayed empty, and leaves those that were there before it.
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
  `EILSEQ` is `NotFound` on read and `InvalidKey` on write;
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
- Declares `contentHeaders`, `presignedUrls`, `rangeReads`, `userMetadata` and
  `userMetadataTokenKeys`.
- `delete` sends at most one `DeleteObjects` request per 1000 keys, plus at most one `DELETE` per
  key holding `U+FFFE` or `U+FFFF` (section 7.4).

### 7.2 Promised providers

AWS S3 and Cloudflare R2, through one adapter that takes no `provider` option and detects nothing.
Where the two answer differently the adapter is written to the stricter side, and the parity core
promises what both hold (ADR 0014). A compatible endpoint can be configured and is not promised,
Google Cloud Storage's XML API among them (ADR 0031).

| Point                              | Promised                                                                                                                                                                                                                                                                                                      |
| ---------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Listing order                      | None. A page holds at most 1000 keys                                                                                                                                                                                                                                                                          |
| Unicode-equivalent keys            | May name one object (R2 normalizes to NFC) or two (S3 keeps both). `keyBytesPreserved` is not declared                                                                                                                                                                                                        |
| `userMetadata`                     | 2 KB of encoded header bytes; keys handed back in lower case                                                                                                                                                                                                                                                  |
| Single `PUT`                       | Up to 5 GB                                                                                                                                                                                                                                                                                                    |
| Object size ceiling                | The provider's, answered with `EntityTooLarge`                                                                                                                                                                                                                                                                |
| `Content-Type`                     | Always sent by `put`, `application/octet-stream` where none was given                                                                                                                                                                                                                                         |
| `CompleteMultipartUpload`          | Judged by its body, which may carry an error under `200`                                                                                                                                                                                                                                                      |
| Writes per key                     | R2 answers `429` above one write per second and key; the retry of section 7.5 may recover a single collision, but does not guarantee it                                                                                                                                                                       |
| Incomplete multipart uploads       | Removed by a lifecycle rule on AWS, after seven days by default on R2; stowage removes none                                                                                                                                                                                                                   |
| Presigned URL host                 | The endpoint that signed it; on R2 the `r2.cloudflarestorage.com` endpoint and not a custom domain                                                                                                                                                                                                            |
| Response overrides on `presignGet` | Answered as the four response headers, on AWS and on R2                                                                                                                                                                                                                                                       |
| Missing bucket                     | `NotFound` without `key` where AWS answers `NoSuchBucket` (section 7.9). Under a token scoped to other buckets, R2 answers `403 AccessDenied` for a missing bucket as for any other, and the call rejects with `AccessDenied`                                                                                 |
| Expired credential                 | R2 answers an expired credential, a temporary credential past its `exp` included, with `403 SignatureDoesNotMatch`, which is `InvalidCredentials` (ADR 0045). Under a session token a refresh follows (section 7.3), and a fresh credential refused too is `InvalidCredentials` with `attempts: 2` (ADR 0065) |
| Objects stored compressed          | An object another tool stored with a content coding may read decoded and longer than its `size`, which is the stored size, or as stored (section 4.4); a range starting inside it is `ProviderError` (section 4.3)                                                                                            |

### 7.3 Credentials

- `credentials` is required. No unsigned request is sent.
- The adapter resolves `credentials` before every request it signs and caches nothing between calls.
  A function is called with `{ forceRefresh: false }`, and with `{ forceRefresh: true }` for one
  refresh after the provider answered `Expired`, whatever the credential, or `SignatureDoesNotMatch`
  to an attempt that carried a session token, which is how R2 answers an expired one (section 7.2).
  The refresh has no delay and is not switched off by `retry: false`. Where the fresh credential is
  refused too, the failure carries `attempts: 2`, and after `SignatureDoesNotMatch` it is
  `InvalidCredentials` whose message says that the temporary credential expired or is not accepted.
  A key pair answered `SignatureDoesNotMatch` gets no refresh, and neither does a session token the
  provider cannot parse, which is `InvalidCredentials` (section 7.9). A `HEAD` is refused without a
  provider code, so `stat`, `exists` and the `HEAD` that describes the destination of `copy` and
  `move` reach the refresh only through the `GET` that follows the refusal, and on the same
  conditions (section 7.9, ADR 0066).
  Caching and rotation are the function's job.
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
  a provider that compresses on request cannot take the `Content-Length` a description reads, and
  so the answer names the coding an object is stored with: offered another encoding, R2 compresses
  an object stored without one and recodes or drops a stored coding (ADR 0044).
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
  another, each on the budget of section 7.5. A `204` counts as deleted. On AWS S3 and R2 such a
  `DELETE` succeeds and removes the object. A failure of the request
  as a whole rejects the call and stops the requests after it; any other failure becomes the key's
  entry in `failed` (ADR 0027).
- A key is percent-encoded segment by segment on the request path, so `#`, `%`, `?`, `+`, a space
  and characters above ASCII reach the provider as written.
- `put` sends the content headers as `Cache-Control`, `Content-Disposition` and
  `Content-Language` on `PutObject` and on `CreateMultipartUpload`, which stores them for the
  object the commit creates. SigV4 signs them with runs of whitespace folded to one space, as AWS
  and R2 compare them, and the provider stores them as sent.
- `stat`, `get`, `copy` and `move` read the content headers and `Content-Encoding` from the answer
  they already read: the `HEAD` or `GET` of the key, and for `copy` and `move` the `HEAD` of the
  destination that describes it. An empty value is read as none. No request whose answer feeds an
  `ObjectStat` carries `response-content-encoding` or another response override, since AWS then
  reports the override in place of the stored value (ADR 0061).

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
- One request costs at most six HTTP requests: three attempts, each doubled by the refresh of
  section 7.3.
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
mapping of section 4.10. One table holds the promised providers' strings, and a compatible
endpoint's string where it names a condition one of them names otherwise and was observed there
(ADR 0041). Such a string promises nothing about that endpoint.

| Provider code                                                                                                                                                                                                                      | Error code           | Note                                                                                                                                                                                                                                                                                                                                                        |
| ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `NoSuchKey`, `NoSuchBucket`                                                                                                                                                                                                        | `NotFound`           | `NoSuchBucket` without `key` (section 4.10)                                                                                                                                                                                                                                                                                                                 |
| `AccessDenied`                                                                                                                                                                                                                     | `AccessDenied`       |                                                                                                                                                                                                                                                                                                                                                             |
| `InvalidAccessKeyId`, `SignatureDoesNotMatch`, `Unauthorized`, `InvalidToken`                                                                                                                                                      | `InvalidCredentials` | `Unauthorized` at `401` is R2's; `InvalidToken` at `400` is AWS's, for a session token it cannot parse                                                                                                                                                                                                                                                      |
| `ExpiredToken`, `ExpiredRequest`                                                                                                                                                                                                   | `Expired`            | `ExpiredRequest` is R2's, sent for an expired presigned URL and not for an expired credential (section 7.2)                                                                                                                                                                                                                                                 |
| `RequestTimeTooSkewed`, `InvalidRange`, `InvalidRequest`, `InvalidArgument`, `MetadataTooLarge`, `EntityTooLarge`, `EntityTooSmall`, `InvalidPart`, `NoSuchPart`, `InvalidPartOrder`, `BadDigest`, `MalformedXML`, `InvalidDigest` | `InvalidRequest`     | `InvalidRequest` is AWS's; `InvalidArgument` with the message `X-Amz-Security-Token` is R2's for a session token it cannot parse and is `InvalidCredentials`, its message saying so in front; otherwise answered to `ListObjectsV2` it is `InvalidOption` naming `cursor`; `NoSuchPart` at `404` is Google Cloud Storage's XML API's, a compatible endpoint |
| `InvalidObjectName`, `KeyTooLongError`                                                                                                                                                                                             | `InvalidKey`         | Reached only for a key the core accepted                                                                                                                                                                                                                                                                                                                    |
| `PermanentRedirect`                                                                                                                                                                                                                | `InvalidOption`      | Names `region` and the region from the header                                                                                                                                                                                                                                                                                                               |
| `NoSuchUpload`, `SlowDown`, `TooManyRequests`, `ServiceUnavailable`, `InternalError`, `RequestTimeout`                                                                                                                             | `ProviderError`      | The last five are transient by status                                                                                                                                                                                                                                                                                                                       |

`status`, `providerCode`, `requestId` (from `x-amz-request-id`) and the provider's message are set
on every error that carries a response. `HEAD` carries no body, so the `HEAD` of `stat` and
`exists`, and the one that describes the destination of `copy` and `move`, is refused without a
code. A refusal with a status from `400` to `499` other than `408` and `429` is followed by a `GET`
of the same key with `Range: bytes=0-0`, sent like any other request and so refreshed where section
7.3 refreshes (ADR 0066):

- Where the `GET` is refused with a provider code, the call rejects with its failure: `NoSuchBucket`
  is `NotFound` without `key`, `NoSuchKey` is `NotFound` with it, and a refused credential is
  `InvalidCredentials` or `Expired` as for `get`.
- Where the `GET` is answered after its refresh, `206` or `416`, the `HEAD` is sent once more, and
  its answer stands as its status reads it, with no request after it.
- Any other answer, one without a refresh or a body without a code, leaves the `HEAD`'s answer
  standing. A `GET` that receives no response is no answer: the call rejects with its
  `NetworkError`, which `exists` rethrows.

A hit costs one request, an absent key, a denied one and a refused key pair two, and an expired
credential the refresh recovers four. A `400` for a key above 1024 bytes is `InvalidKey`, the
`KeyTooLongError` the body would have named, and is followed by no `GET`.

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
  cacheControl?: string;
  contentDisposition?: string;
  contentLanguage?: string;
}
```

- `expiresIn` is seconds, 1 to 604800; outside that it is `InvalidOption`. The credential that
  signs may cut the lifetime shorter.
- `contentLength` is a finite, non-negative integer. A negative, fractional, `NaN` or infinite
  value is `InvalidOption` naming `contentLength` before signing.
- `presignGet` signs `GetObject` on an addressable key. The four response overrides are sent as
  query parameters and are answered as the corresponding response headers.
- `presignPut` signs `PutObject` on a writable key with `Content-Type` and `Content-Length` bound
  through signed headers, and returns the URL with `headers` holding `content-type`. A body of
  another type or another length is rejected by the provider. No user metadata, no checksum and no
  upper bound on the length can be signed in.
- `cacheControl`, `contentDisposition` and `contentLanguage` are checked as `put` checks them
  (section 4.3), the content type always counted in the 2,048 bytes, and each one given is signed
  as `Cache-Control`, `Content-Disposition` or `Content-Language` and returned in `headers` under
  that name in lower case. AWS and R2 answer a value that differs from the signed one, or is
  missing, with `403`, and store the signed one as sent. A content header left out is not bound:
  whoever holds the URL may send it, and the provider stores it (ADR 0063).
- Every binding is exact up to runs of spaces: SigV4 collapses them before comparing, so a URL
  signed for `public, max-age=60` admits `public,  max-age=60`, which the provider stores with both
  spaces. It admits no other type, length, disposition, cache directive or language than the one
  signed.
- The URL is a bearer token: whoever holds it may perform that one operation on that one key until
  it expires. It works against the endpoint that signed it only.
- Neither method sends a request. Both reject with `InvalidKey`, `InvalidOption`, `InvalidRequest`
  or `InvalidCredentials` before signing; a provider's rejection of the URL reaches whoever calls it
  and never the adapter. `@stowage/core` offers no function that turns such a response into a
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
  environment (ADR 0021). It takes Azure's rule for an account name, 3 to 24 lower-case letters and
  digits, with an `endpoint` or without one; anything else is `InvalidOption` at construction,
  since without an `endpoint` the account becomes the host a bearer token is sent to.
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
- Declares `contentHeaders`, `keyBytesPreserved`, `presignedUrls`, `rangeReads` and
  `userMetadata`. It does not declare `userMetadataTokenKeys`.
- Refuses three kinds of writable key with `InvalidKey` and `attempts: 0`: more than 254
  segments, a segment ending in `.`, and a key holding a character from `U+0080` to `U+009F`.
  A noncharacter such as `U+FFFE` is not refused: the account stores and lists such a key as
  written. Addressable keys and prefixes are refused by nothing beyond the rule of section 4.8 (ADR
  0020).
- `delete` sends at most one Blob Batch request per 256 keys.

### 8.2 Promised provider

Azure Blob Storage in the public cloud: a general-purpose v2 account without hierarchical
namespace, holding block blobs. An account with hierarchical namespace, a sovereign cloud and
another endpoint that speaks the Blob wire protocol can be configured and are not promised.

| Point                              | Promised                                                                                                                                                                                                           |
| ---------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Listing order                      | None. A page holds at most 1000 names                                                                                                                                                                              |
| Unicode-equivalent keys            | Two blobs: an NFC and an NFD name are stored, listed and read apart. `keyBytesPreserved` is declared                                                                                                               |
| `userMetadata`                     | ASCII identifier keys, stored and handed back in lower case; 2 KB as section 4.3 measures them                                                                                                                     |
| Single `Put Blob`                  | Up to 5,000 MiB                                                                                                                                                                                                    |
| Object size ceiling                | 50,000 blocks of at most 4,000 MiB; the upload of section 8.6 stops at 50,000 parts                                                                                                                                |
| `Content-Type`                     | Always sent by `put`, on the commit of a block upload as well, `application/octet-stream` where none was given                                                                                                     |
| Writes per key                     | Of two writers, one may be rejected (section 8.6)                                                                                                                                                                  |
| Uncommitted blocks                 | Kept until the next commit or `Put Blob` to the name, or until the service discards them seven days after the last block; stowage removes none                                                                     |
| Presigned URL host                 | The endpoint that signed it                                                                                                                                                                                        |
| Response overrides on `presignGet` | Answered as the three response headers                                                                                                                                                                             |
| Objects stored compressed          | An object another tool stored with a content coding may read decoded and longer than its `size`, which is the stored size, or as stored (section 4.4); a range starting inside it is `ProviderError` (section 4.3) |

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
- A presigned URL signed under an account key works until it expires or the key is regenerated. One
  signed under an access token outlives the token and stops working at `se`, and its user delegation
  key does not expire before then; revoking the account's user delegation keys, or the role
  assignment behind the token, revokes it, after a delay of Azure's.

### 8.4 Requests

- Every request carries `x-ms-version: 2026-04-06`, and every SAS the adapter signs `sv=2026-04-06`.
  A subrequest inside a Blob Batch carries none, since the batch request names it for all of them.
- Under an account key a request is signed with Shared Key, which signs the length and no hash of
  the body. Canonical headers are ordered by code point with `_` placed before the digits, never
  by a runtime's collation. Every `x-ms-` value is signed trimmed and otherwise as sent, a tab and
  a run of spaces included, since Azure hashes it so (ADR 0059). Under an access token a request
  carries it as `Authorization: Bearer`.
- Every request carries a body the adapter holds; Azure refuses a chunked `Put Blob`, so a stream
  travels as held parts (section 8.6).
- Every request asks for the bytes as the provider stores them, `Accept-Encoding: identity`, as in
  section 7.4.
- A key is percent-encoded segment by segment on the request path, as in section 7.4.
- Listings are `List Blobs` answers, read through `parseXml` of section 4.13. A `Name` marked
  `Encoded="true"`, which is how Azure carries a name holding `U+FFFE` or `U+FFFF`, is decoded as
  percent-encoded UTF-8.
- A `userMetadata` key is sent folded to lower case. Azure keeps the case of a name, but `fetch`
  hands every header name back in lower case on every runtime, so no read could return another
  (ADR 0029).
- A `userMetadata` value holding a run of whitespace is sent as encoded words even where it would
  travel as written, and read back decoded.
- `stat`, `get`, `copy` and `move` read the content headers from `Cache-Control`,
  `Content-Disposition` and `Content-Language`, and the coding from `Content-Encoding`, of the
  answer they already read: the `HEAD` or `GET` of the key, and for `copy` and `move` the `HEAD` of
  the destination that describes it. An empty value is read as none. No request whose answer feeds
  an `ObjectStat` carries `rscc`, `rscd` or another response override (ADR 0061).
- `stat` and `exists` read the provider code from `x-ms-error-code`, which Azure sends on a `HEAD`
  as well, so a missing blob and a missing container carry their own codes.
- `delete` sends Blob Batch requests of at most 256 `Delete Blob` subrequests. A subrequest
  answered `404 BlobNotFound` counts as deleted. A subrequest answered `404 ContainerNotFound`
  rejects the whole call with `NotFound` without `key` (section 4.10). Any other failed subrequest
  becomes the key's entry in `failed`, with the code section 8.8 maps; a failure of the batch
  request as a whole rejects the call.

### 8.5 Retries

- Section 7.5 holds here: the transient conditions, the budget of three attempts per HTTP request,
  `maxAttempts`, the curve, `retry: false`, no `Retry-After`, no total time budget and no timeout
  per attempt. Azure throttles with `503 ServerBusy` and `500 OperationTimedOut`, which the status
  group already holds.
- `Put Block List` names every block as `<Latest>` and is repeated like every other request, after
  a transport failure that received no response too: a repeat commits the same blocks in the same
  order. Section 7.7 is S3's alone, and a `put` of any size is answered with certainty, except
  where another writer replaced the key between a lost commit and its repeat (section 8.6).
- The refresh after `401 InvalidAuthenticationInfo` of section 8.3 doubles an attempt as the
  refresh of section 7.3 does on S3, so one request costs at most six HTTP requests.
- A per-key failure in `delete` is reported, not repeated. A body stream that breaks during `get` is
  not resumed.

### 8.6 Uploads

- A `Uint8Array` or string goes as one `Put Blob` up to 5,000 MiB. Above that Azure answers
  `413 RequestBodyTooLarge`, which is `InvalidRequest`; the adapter does not split held bytes.
- A `ReadableStream` is read into parts of `partSize`. A stream that ends within one part goes as
  one `Put Blob`. A stream that fills more than one part is staged as blocks with `concurrency`
  parts in flight and committed with one `Put Block List`, which carries the content type, the
  content headers and the user metadata.
- The content headers travel as `x-ms-blob-cache-control`, `x-ms-blob-content-disposition` and
  `x-ms-blob-content-language`, on `Put Blob` as on `Put Block List`, beside the standard
  `Content-Type` of `Put Blob` and the `x-ms-blob-content-type` of `Put Block List`. A commit clears
  what it does not name, so `Put Block List` restates every one the `put` carries (ADR 0059).
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
  5,000 MiB. Nothing is sent in front of it. The service copies the content type, the content
  headers, the content coding and the user metadata of the source, and removes the whitespace
  around the commas of a `Content-Language` list, `de-AT, en` becoming `de-AT,en` (section 4.11);
  the destination is replaced once the copy succeeded, and a failure leaves it as it was.
- The request authorizes its source. Under an account key it carries a service SAS for the source,
  signed for each attempt with `sp=r`, `sr=b`, `st` 15 minutes in the past and `se` 60 minutes from
  now. Under an access token it carries `x-ms-copy-source-authorization: Bearer` with the token of
  its own `Authorization`, so the repeat of section 8.3 renews both.
- Above 5,000 MiB the service answers `409 CannotVerifyCopySource` although the source is readable,
  which is `InvalidRequest` saying that the source is above 5,000 MiB or reported no valid length.
  There is no fallback to blocks copied by range or to `Copy Blob`. `move` inherits that.
- `move` is `copy` followed by an unconditional `Delete Blob` on `from`.
- Copying a key onto itself is `InvalidRequest` before any request.

### 8.8 Provider codes

A recognized provider code decides the error code alone; an unrecognized one falls to the status
mapping of section 4.10. `status`, `providerCode` from `x-ms-error-code`, `requestId` from
`x-ms-request-id`, and the provider's message where a body carries one are set on every error that
carries a response.

| Provider code                                                                                                            | Error code           | Note                                                                                                                                                                                  |
| ------------------------------------------------------------------------------------------------------------------------ | -------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `BlobNotFound`, `ContainerNotFound`, `ResourceNotFound`                                                                  | `NotFound`           | `BlobNotFound` on `delete` counts as deleted; `ContainerNotFound` without `key` (section 4.10)                                                                                        |
| `AuthorizationPermissionMismatch`, `InsufficientAccountPermissions`, `AccountIsDisabled`, `UnauthorizedBlobOverwrite`    | `AccessDenied`       | The principal is authenticated and lacks the role                                                                                                                                     |
| `InvalidAuthenticationInfo`, `NoAuthenticationInformation`, `AuthenticationFailed`, `KeyBasedAuthenticationNotPermitted` | `InvalidCredentials` | `InvalidAuthenticationInfo` under an access token after the one repeat of section 8.3; `AuthenticationFailed` includes a clock skew, which Azure does not tell apart from a wrong key |
| `InvalidRange`, `RequestBodyTooLarge`, `BlockCountExceedsLimit`, `MetadataTooLarge`, `InvalidMetadata`                   | `InvalidRequest`     | The metadata codes are reached only for metadata the core accepted                                                                                                                    |
| `InvalidBlockList`, `InvalidBlobOrBlock`                                                                                 | `ProviderError`      | `retryable: false`; on a block upload, usually another writer won (section 8.6)                                                                                                       |
| `PendingCopyOperation`, `BlobArchived`, `SnapshotsPresent`, `LeaseIdMissing`, `BlobImmutableDueToPolicy`                 | `ProviderError`      | A state of the blob stowage does not create                                                                                                                                           |
| `ServerBusy`, `InternalError`, `OperationTimedOut`                                                                       | `ProviderError`      | Transient by status                                                                                                                                                                   |
| `CannotVerifyCopySource`                                                                                                 | By the source        | Mapped through `x-ms-copy-source-status-code` where present, else the response's status, with `key` set to `from`                                                                     |

- On `Put Blob From URL`, a `409` whose code the table does not name is `InvalidRequest` (section
  8.7), and so is a `409 CannotVerifyCopySource` whose `x-ms-copy-source-status-code` is missing
  or names no failure, with `key` set to `to`.
- A `400` for a key above 1,024 characters or 254 segments is `InvalidKey`, as section 7.9 has it
  for S3: an addressable key the provider cannot hold. Azure answers a name above 1,024 characters
  with `400` on a `HEAD` too, so `stat` and `exists` report `InvalidKey` as well.
- A `marker` the service no longer continues from is answered with `400 InvalidInput`, which the
  table does not name, so `list` rejects with `ProviderError`.

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
  cacheControl?: string;
  contentDisposition?: string;
  contentLanguage?: string;
}
```

A URL is a SAS, and the credential of the call decides which kind (ADR 0022):

| Credential    | `presignGet`          | `presignPut`                                                             |
| ------------- | --------------------- | ------------------------------------------------------------------------ |
| `accountKey`  | A service SAS         | `InvalidCredentials` naming `accountKey`                                 |
| `accessToken` | A user delegation SAS | A user delegation SAS binding four headers and the content headers given |

- `expiresIn` and `contentLength` take what section 7.10 has them take, and are checked before
  anything is sent. `contentLength` is not checked against the 5,000 MiB of a single `Put Blob`.
  The binding is exact up to runs of spaces, as section 7.10 states it.
- `presignGet` signs `sp=r` on an addressable key. The three response overrides are sent as `rsct`,
  `rscd` and `rscc` and are answered as the corresponding response headers. Azure has no override
  for `Expires`.
- `presignPut` signs `sp=w` on a writable key with
  `srh=content-type,content-length,x-ms-blob-type,x-ms-blob-content-type` and returns `headers`
  holding `content-type`, `x-ms-blob-type: BlockBlob` and `x-ms-blob-content-type`, the content
  type again. A body of another content type, one differing in case or parameters included, a
  body of another length, and another blob type are rejected with `403 AuthenticationFailed`; a
  request without `x-ms-blob-type` with `400 MissingRequiredHeader`. `x-ms-blob-content-type` is
  bound because `Put Blob` stores it in place of `Content-Type`, so an unsigned one could store
  another type than the one signed (ADR 0063). An existing blob is overwritten, as a presigned
  `PUT` does on S3.
- `cacheControl`, `contentDisposition` and `contentLanguage` are checked as `put` checks them
  (section 4.3), the content type always counted in the 2,048 bytes, before the user delegation key
  is requested. Each one given is signed as `x-ms-blob-cache-control`,
  `x-ms-blob-content-disposition` or `x-ms-blob-content-language`, appended to `srh` in that order,
  and returned in `headers` under that name; `Put Blob` stores no standard `Content-Disposition`. A
  content header left out is not bound: whoever holds the URL may send it, and Azure stores it. That
  Azure refuses a value that differs from the signed one or is missing is a promise of section 18.
- Under an account key `presignPut` rejects before any request, because a service SAS binds no
  request header. Its message says that `presignPut` needs an access token.
- Every SAS carries `sr=b`, `st` 15 minutes in the past unless the next point moves it, `se`
  `expiresIn` seconds from now, and `spr=https`, or `https,http` where the endpoint is a loopback
  address; none carries `sip`. An account with a SAS expiration policy therefore measures
  `expiresIn + 900` seconds.
- Under an access token, where `st` 15 minutes in the past would lie more than 604800 seconds before
  `se`, `st` is `se` less 604800 seconds instead, so that a SAS and its key span seven days at
  most and a SAS expiration policy of seven days admits every URL. Above an `expiresIn` of 603900
  the URL keeps less of the 15 minutes for clock skew, and at 604800 `st` is the moment of signing;
  a caller who needs the whole 15 minutes passes 603900 or less (ADR 0022).
- Under an access token each call requests one user delegation key, valid from `st` until `se` or 15
  minutes from now, whichever is later, and keeps it nowhere; it is an ordinary request of the
  adapter under sections 8.3 and 8.5, and a refusal of it is `AccessDenied`. The principal needs the
  account's `generateUserDelegationKey` action and the data role for the operation it signs.
- The URL is a bearer token: whoever holds it may perform that one operation on that one key until
  it expires. It works against the endpoint that signed it only.
- There is no presigned block upload.

## 9. `@stowage/adapter-gcs`

### 9.1 Construction

```ts
export type GcsCredentials = { accessToken: string };

export type GcsSigner =
  | { serviceAccount: string; privateKey: Resolvable<string | CryptoKey> }
  | { serviceAccount: string; credentials: Resolvable<GcsCredentials> };

export interface GcsAdapterOptions {
  bucket: string;
  endpoint?: string;
  credentials: Resolvable<GcsCredentials>;
  signer?: GcsSigner;
  retry?: false | { maxAttempts?: number };
  multipart?: { partSize?: number };
}

export interface GcsStorage extends Storage {
  readonly provider: "gcs";
}

export interface GcsSigningStorage extends GcsStorage {
  presignGet(key: string, options: GcsPresignGetOptions): Promise<string>;
  presignPut(key: string, options: GcsPresignPutOptions): Promise<PresignedPut>;
}

export function gcsStorage(options: GcsAdapterOptions & { signer: GcsSigner }): GcsSigningStorage;
export function gcsStorage(options: GcsAdapterOptions): GcsStorage;
```

- `bucket` is the bucket name. There is no `project`: no request the adapter sends names one, and
  `signBlob` addresses its service account under `projects/-`. Nothing is read from the host or
  the environment (ADR 0033).
- `endpoint` absent addresses `https://storage.googleapis.com`. Given, it follows the rules of
  section 7.1: an absolute URL with no userinfo, no query and no fragment, `https:` always and
  `http:` only where the host is a loopback address; anything else is `InvalidOption` at
  construction. A path in it becomes the prefix of every request path and of every URL the adapter
  signs, so fake-gcs-server is configured as `http://127.0.0.1:<port>`.
- Every option is validated at construction. An unknown key is `InvalidOption`. `maxAttempts` takes
  the integers 1 to 3, `partSize` the multiples of 256 KiB from 256 KiB to 5 GiB in bytes; outside
  those the value is `InvalidOption` and is not clamped. There is no `concurrency` (section 9.6). A
  configuration shared with `adapter-s3` or `adapter-azure-blob` keeps its `partSize` a multiple of
  256 KiB.
- `signer`, where given, holds a non-empty `serviceAccount` and exactly one of `privateKey` and
  `credentials`; a missing, empty or unknown field is `InvalidOption` at construction. The signer
  is not `Resolvable` as a whole, since it decides the declaration; what it holds is resolved per
  call (section 9.9).
- `gcsStorage` is overloaded on `signer`. With one it returns `GcsSigningStorage`, which carries
  `presignGet` and `presignPut`; without one it returns `GcsStorage`, which carries neither. A
  caller whose `signer` may be absent gets `GcsStorage`, narrower than the storage at runtime (ADR
  0035).
- `put` on `GcsStorage` accepts the `PutOptions` of section 4.3 and nothing more. Storage classes,
  ACLs, preconditions, object versioning, holds, retention policies, customer-managed and
  customer-supplied encryption keys and Autoclass are not offered.
- Declares `contentHeaders`, `keyBytesPreserved`, `rangeReads`, `userMetadata` and
  `userMetadataTokenKeys`, and `presignedUrls` where `signer` is given (ADR 0032).
- Refuses two kinds of writable key with `InvalidKey` and `attempts: 0`: a key starting with
  `.well-known/acme-challenge/`, and a key holding `U+FFFE` or `U+FFFF`, both of which GCS refuses
  to store. `.well-known/acme-challenge-x`, other noncharacters such as `U+FDD0`, and the C1
  controls from `U+0080` to `U+009F` are not refused. Addressable keys and prefixes are refused by
  nothing beyond the rule of section 4.8 (ADR 0032).
- `delete` sends at most one batch request per 100 keys.

### 9.2 Promised provider

Google Cloud Storage in the public cloud: a bucket with uniform bucket-level access and without
hierarchical namespace, in any storage class, with soft delete or without it. A bucket with
hierarchical namespace or dual-region turbo replication, another universe, and another endpoint
that speaks the JSON API, fake-gcs-server among them, can be configured and are not promised. GCS
reached through `adapter-s3` over the XML API is an S3-compatible endpoint like any other (section
7.2, ADR 0031).

| Point                              | Promised                                                                                                                                                                    |
| ---------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Listing order                      | None. A page holds at most 1000 names                                                                                                                                       |
| Unicode-equivalent keys            | Two objects: an NFC and an NFD name are stored, listed and read apart. `keyBytesPreserved` is declared                                                                      |
| `userMetadata`                     | Any ASCII HTTP token as a key, stored in lower case and handed back as stored; values stored as written; 2 KB as section 4.3 measures them                                  |
| Single request                     | Up to 5 TiB, the ceiling of an object                                                                                                                                       |
| Object size ceiling                | 5 TiB. A resumable session has no part limit; GCS refuses the chunk that crosses the ceiling                                                                                |
| `Content-Type`                     | Always sent by `put`, on the start of a resumable session as well, `application/octet-stream` where none was given                                                          |
| Writes per key                     | GCS answers `429` above one write per second and name; the retry of section 9.5 may recover a collision, but does not guarantee it. The later commit wins                   |
| Incomplete uploads                 | A session whose cancel did not arrive keeps its bytes until GCS removes it a week after it started; stowage removes none                                                    |
| Storage class                      | `put` and `copy` write the bucket's default class; `move` keeps the source's                                                                                                |
| Objects stored compressed          | An object another tool stored with a content coding may read decoded and longer than its `size`, which is the stored size (section 4.4); any range on it is `ProviderError` |
| Presigned URL host                 | The configured endpoint, path-style                                                                                                                                         |
| Response overrides on `presignGet` | Answered as the two response headers; GCS ignores `response-cache-control` and `response-expires`, so `GcsPresignGetOptions` carries neither                                |

### 9.3 Credentials

- `credentials` is required. `{ accessToken }` is an OAuth 2.0 bearer token for a scope that
  covers the operations, such as `https://www.googleapis.com/auth/devstorage.read_write`, which the
  caller's resolver obtained. It is promised on all four runtimes. The token is opaque and is not
  parsed as a JWT.
- The adapter resolves `credentials` before every request that carries it and caches nothing
  between calls. The chunks, the commit and the cancel of a resumable session carry none (section
  9.6), so a streamed `put` resolves the credential once, for the start of the session (ADR
  0036).
- A function is called with `{ forceRefresh: false }`, and with `{ forceRefresh: true }` once after
  the provider answered `401` with `error=invalid_token` in `WWW-Authenticate`, which GCS answers
  alike to an expired, a revoked and a malformed token: a token past its expiry is answered as a
  made-up one is, with the provider code `authError`. That repeat has no delay and is not switched
  off by `retry: false`. Where the repeat is refused too, the failure is `InvalidCredentials` with
  `attempts: 2`, and its message says that the token expired or is not accepted. Any other `401` is
  `InvalidCredentials` and not repeated. The adapter never reports `Expired`, since no answer tells
  an expired token apart (ADR 0033).
- Before a request goes out with it, the resolved object is checked to hold `accessToken` as a
  non-empty string and no other field; a violation is `InvalidCredentials` naming the field, with
  `attempts: 0`.
- There is no `fromEnv`. No HMAC key and no service-account key is taken as a credential, and no
  token is acquired: no key exchange, no metadata server, no workload identity federation. A caller
  holding a `google-auth-library` client wraps it in a resolver of their own.
- No package takes a key file or a credential configuration file. A caller holding one reads it
  and passes what the resolver or the `signer` takes.

### 9.4 Requests

- Every request goes to the JSON API, `storage/v1` and `upload/storage/v1` below the endpoint. The
  XML API is reached only by the URLs the adapter signs (section 9.9).
- A request that carries the credential carries it as `Authorization: Bearer`.
- A key is percent-encoded as one path segment, `/` included, on the JSON API, and segment by
  segment in a signed URL, so `#`, `%`, `?`, `+`, a space and characters above ASCII reach the
  provider as written.
- `list` sends `maxResults` on every page, the walk of `deleteAll` included, and continues with
  the answer's `nextPageToken`. The cursor carries a tag of the adapter's own, so a cursor of
  another storage is `InvalidOption` naming `cursor` before any request. A cursor of this storage
  handed to a listing of another prefix is not detected: GCS answers it with an empty page (ADR
  0038).
- `stat` and `exists` read the object's resource. `get` sends the resource request and the media
  download side by side, since the media download carries no user metadata. Where the two name
  different generations, because a writer replaced the object between them, the resource is read
  again pinned to the media download's generation, and the body is kept. GCS answers `404` to a
  request pinned to a generation a writer replaced, `notFound` on the resource and without a
  provider code on the media download. Where the pinned resource answers `404 notFound`, the body
  is canceled and the media download is sent again pinned to the first resource's generation, with
  the range. Where that answers `404` as well, `get` rejects with `NotFound` whose `key` is set,
  although the key may hold a newer object. Each of the two is one request on the budget of section
  9.5, and `stat` describes the bytes the body carries. Which generation is newer is not read from
  their numbers, which GCS does not promise to increase (ADR 0032, ADR 0040).
- A `userMetadata` key is sent folded to lower case, and values travel in the JSON body as
  written, raw Unicode included. Keys are handed back as stored, so an object another tool wrote
  with `A` and `a` returns both. A stored value that holds RFC 2047 encoded words is decoded on the
  way back, so an object `adapter-s3` wrote through the XML API reads the same. A reader of the
  XML API sees a raw value outside ASCII garbled: the `ü` of `grüße` reaches `fetch` on an XML
  `HEAD` as `Ã¼` (ADR 0032).
- The content headers travel as the members `cacheControl`, `contentDisposition` and
  `contentLanguage` of the object resource, as written, and are read from the resource, never from
  the media download; so is the coding, from its `contentEncoding`. An empty value is read as none
  (ADR 0061).
- An object stored with a content coding is read as `fetch` hands it over: GCS decodes gzip, and
  the runtime decodes a coding GCS serves as stored where it knows it, which Deno does for `gzip`
  and `br` alone. `size` stays the stored size, so the body may be longer. Every `range` on such an
  object is `ProviderError` through `contentCodingRefusal` of section 4.13, its body canceled,
  handed the stored coding the resource's `contentEncoding` or the media download's
  `x-goog-stored-content-encoding` carries; `rangeStartRefusal` does not run on it. stowage never
  writes `Content-Encoding` itself (ADR 0040, ADR 0044).
- `delete` sends batch requests of at most 100 deletes. A subresponse answered `404 notFound`
  counts as deleted. A missing bucket, which a batch answers with the same `404 notFound`, is told
  apart by its message and rejects the whole call with `NotFound`. Any other failed subresponse
  becomes the key's entry in `failed`, with the code section 9.8 maps; a failure of the batch
  request as a whole rejects the call. The answer is read with each `Content-ID` echoed as
  `response-0`, as GCS echoes the bare `0` the subrequest carries, and, where that form cannot
  read it, as sent, as fake-gcs-server echoes it.

### 9.5 Retries

- Section 7.5 holds here: the transient conditions, the budget of three attempts per HTTP request,
  `maxAttempts`, the curve, `retry: false`, no `Retry-After`, which GCS does not send, no total
  time budget and no timeout per attempt, except for the cleanup timeout of section 9.6.
- Every request of a resumable session is repeated as it was sent, its commit included: GCS
  ignores persisted bytes sent again and answers a repeated commit with the same object. The
  adapter never sends a status query. The start of a session is repeated as
  `CreateMultipartUpload` is on S3, and a session an earlier attempt created stays unseen until it
  expires. Section 7.7 is S3's alone.
- Every call of a `copy` is repeated as sent, on its own budget (section 9.7).
- `move` is repeated like every other request. A `404` answered to an attempt after one that
  received no response or a `5xx` rejects with that earlier failure, `NetworkError` or
  `ProviderError`, `retryable: true`, with `attempts` counting every attempt, since the move may
  have happened. That later `404` remains ambiguous unless the adapter can identify the destination
  as the object committed by this move; `stat(to)` alone is insufficient when the destination may
  have pre-existed. It is the one ambiguous outcome on GCS (ADR 0037).
- The refresh after `401` of section 9.3 doubles an attempt as the refresh of section 7.3 does on
  S3, so one request that carries the credential costs at most six HTTP requests.
- A per-key failure in `delete` is reported, not repeated. A body stream that breaks during `get` is
  not resumed.

### 9.6 Uploads

- A `Uint8Array` or string goes as one `uploadType=multipart` request, whose body holds the
  object's name, content type, content headers and user metadata and then the bytes, up to 5 TiB.
  The adapter does not split held bytes.
- A `ReadableStream` is read into parts of `partSize`. A stream that ends within one part goes as
  the same single request. A stream that fills more than one part becomes one resumable session:
  a start that carries the content type, the content headers and the user metadata, then the parts
  as chunks one after another, each at its offset, with no part in flight beside another.
- `partSize` defaults to 8 MiB, so a streamed `put` holds 8 MiB of part buffers for an object of
  any size, a quarter of what S3 and Azure hold, and takes longer than they do for the same bytes.
  The default moves in a minor release and never in a patch.
- A part shorter than `partSize` is the last one and carries the total, which commits the session.
  When the last part is full, an empty request naming the total commits after it. The commit
  answers with the object, which `put` resolves with.
- GCS may persist less of a chunk than it was sent. The adapter reads the acknowledged range of
  every `308` and sends the rest of the part from its buffer; that spends no attempt. A `308` that
  acknowledges nothing new is a failed attempt, and a range that falls outside what was sent is
  `ProviderError`. The `308` carries no `Location`, so it reaches the adapter as it is under
  `fetch`'s default `redirect: "follow"`, on all four runtimes (ADR 0036).
- A part that fails is repeated on the budget of section 9.5. Once one part has spent its budget,
  the source stream is canceled, the session is canceled with an independent 10-second timeout
  covering all attempts, backoff and reading the answer,
  and `put` rejects with that part's error. The caller's abort cancels the source and the session
  the same way and rejects with `AbortError`. A failure of the cancel is not reported.
- Where a commit spent its budget without a response, the adapter cancels the session and reads
  the answer: a committed session answers with its object, which `put` resolves with; an open one
  is gone, and `put` rejects with the commit's `NetworkError`. Only where the cancel receives no
  response either does the outcome stay open. A failed or timed-out cancel rejects `put` with the
  original commit error; neither the cleanup error nor its timeout replaces it.
- A session whose cancel did not arrive holds the bytes persisted so far until GCS removes it a week
  after it started. The API does not see it: `stat`, `get` and `list` answer as before the upload.
- The chunks, the commit and the cancel carry no credential: the session URI authorizes them, and
  GCS checks no token there. An upload that runs longer than its token lives needs no refresh. The
  session URI is itself a credential for a week and never leaves the adapter, in a message, a
  `cause` or any field.
- Two sessions for one name are independent, and the later commit wins.
- Nothing about a resumable session reaches the API: no progress, no session URI, no resume.

### 9.7 Copies

- `copy` sends `rewriteTo` and sends it again with the token of each answer until one says that
  the rewrite is done, and resolves with the object that answer carries. Nothing is sent in front
  of it. It succeeds up to the 5 TiB an object holds; there is no bound of the adapter's own and no
  `copyTo`.
- A copy within one storage class answers in one call. A source in another class than the
  bucket's default changes class on the way: its bytes are copied, which may take several calls
  and is billed as a retrieval of the source.
- The destination takes the bucket's default storage class, and the content type, the content
  headers, the content coding and the user metadata of the source; `rewriteTo` is sent without a
  body. It does not change before the call that finishes the rewrite, so a failed or
  aborted `copy` leaves it as it was and sends nothing to clean up.
- The rewrite token pins the source's generation. A source replaced or deleted between two calls
  rejects with `NotFound`, `key` set to `from`, although the key may hold a newer object; `copy`
  called again copies that one.
- There is no budget over the copy as a whole: each call has its own, and the caller's
  `AbortSignal` bounds the rest.
- `move` sends one `objects.move`, which keeps the bytes, the content type, the content headers, the
  content coding, the user metadata and the storage class, replaces an object at `to`, and removes
  `from`. A `move` that fails leaves both keys as they were, except in the one ambiguous outcome of
  section 9.5.
- Copying a key onto itself is `InvalidRequest` before any request.

### 9.8 Provider codes

A failure body is read as JSON whatever its `Content-Type`. Where it holds `error`,
`errors[0].reason` is `providerCode` and decides through the table below, and `error.message` is
the message word for word. A body that is no JSON and does not start with `<` is the message, its
character references decoded. A body that starts with `<` is not read, and the message names the
status. Where no provider code arrived, `providerCode` stays unset and the status decides as
section 4.10 has it, except for a `404`. `retryable` follows the status alone (ADR 0038).

| Provider code                                        | Error code           | Note                                                                                 |
| ---------------------------------------------------- | -------------------- | ------------------------------------------------------------------------------------ |
| `notFound`                                           | `NotFound`           | A missing bucket by its message, without `key`                                       |
| `forbidden`, `insufficientPermissions`               | `AccessDenied`       | The principal is authenticated and lacks the role, or its token the scope            |
| `objectUnderActiveHold`, `retentionPolicyNotMet`     | `ProviderError`      | A state of the object stowage does not create                                        |
| `authError`, `required`                              | `InvalidCredentials` | After the one repeat of section 9.3 where `WWW-Authenticate` carries `invalid_token` |
| `invalidArgument`, `requestedRangeNotSatisfiable`    | `InvalidRequest`     |                                                                                      |
| `uploadTooLarge`                                     | `InvalidRequest`     | Above the 5 TiB an object holds                                                      |
| `invalid`                                            | `ProviderError`      | `InvalidOption` naming `cursor` where answered to a `list` that carried a cursor     |
| `conditionNotMet`, `conflict`, `clientClosedRequest` | `ProviderError`      | By status; stowage sends no precondition, and `499` answers a canceled session       |

- On the resource, the listing, a `DELETE`, a batch subresponse, `rewriteTo` and `moveTo`, a `404`
  means absence only with the provider code `notFound`. Any other `404` there is `ProviderError`,
  `retryable: false`, whose message says that the endpoint serves no such path, so an `endpoint`
  with a wrong path prefix is not read as an empty bucket. A `404` from a session URI is
  `ProviderError` as well: the session and its bytes are gone. The media download carries no
  provider code and is read by its status.
- A missing bucket answers `404` with "The specified bucket does not exist." on every path, and is
  `NotFound` without `key`. `exists` rethrows it (section 4.10).
- A key above 1024 bytes, which the addressable rule lets through, is answered `404 notFound` and
  is `NotFound`, and `delete` counts it as deleted, where sections 7.9 and 8.8 report `InvalidKey`.
  So is a read or delete of a name GCS cannot hold.
- In `get`, where the resource request fails, its failure is reported, and a failure of the media
  download only where the resource succeeded; either failure aborts the other request, except a
  media `416`, which leaves the resource request running for the size its report names. `attempts`
  counts the request whose failure is reported. A `get` racing the creation or deletion of its key
  may answer `NotFound`. After a generation mismatch, a `404` of the resource pinned to the media
  download's generation is no failure, and a `404` of the media download pinned after it is
  `NotFound` with `key`, its message word for word (section 9.4, ADR 0040).
- A media `416` is reported as `rangeStartRefusal` of section 4.13 for the size the resource named:
  `InvalidRequest`, `status: 416`, no `providerCode`.
- `status` is set on every error that carries a response, the message where a body carries one.
  `requestId` is `x-guploader-uploadid`, the outer answer's for a key's entry of a batch, and unset
  on every request of a resumable session, where the header holds the value that authorizes the
  session.

### 9.9 Presigned URLs

```ts
export interface GcsPresignGetOptions {
  expiresIn: number;
  responseContentType?: string;
  responseContentDisposition?: string;
}

export interface GcsPresignPutOptions {
  expiresIn: number;
  contentType: string;
  contentLength: number;
  cacheControl?: string;
  contentDisposition?: string;
  contentLanguage?: string;
}
```

A URL is a V4 signed URL on the XML API, signed as the `signer`'s service account with
`GOOG4-RSA-SHA256`. The field present decides how (ADR 0035):

| Signer            | How it signs                                                                     | Requests per URL |
| ----------------- | -------------------------------------------------------------------------------- | ---------------- |
| `{ privateKey }`  | Locally with Web Crypto, from a PKCS#8 PEM or a `CryptoKey` able to sign         | None             |
| `{ credentials }` | Through `signBlob` of the IAM Credentials API, under a token of the signer's own | One              |

- `expiresIn` and `contentLength` take what section 7.10 has them take, and are checked before
  anything is sent. The keys section 9.1 refuses are `InvalidKey` here too.
- `privateKey` and the signer's `credentials` are resolved on every call and cached nowhere. A
  `privateKey` that is neither a PKCS#8 PEM nor an RSA `CryptoKey` able to sign is
  `InvalidCredentials` naming `privateKey`, with `attempts: 0`.
- Under `signBlob` the call is an ordinary request of the adapter under sections 9.3 and 9.5: the
  repeat after `401` calls the signer's `credentials` with `forceRefresh`, and `403` is
  `AccessDenied`, a service account that does not exist included. Its token needs the scope `iam`
  or `cloud-platform`, and its principal `iam.serviceAccounts.signBlob` on the service account,
  which Service Account Token Creator grants; the service account needs the data role for the
  operation it signs. Nothing is kept between calls.
- The URL is path-style, `<endpoint>/<bucket>/<key>`, on the configured endpoint's scheme and host
  with its path kept. Virtual-hosted URLs and custom domains are not offered.
- `X-Goog-Date` is the moment of signing and is not dated back. A signer whose clock runs slow
  shortens the URL by that much; GCS refuses a date more than about 15 minutes ahead of its own.
- `presignGet` signs `GET` on an addressable key. `responseContentType` and
  `responseContentDisposition` are sent as `response-content-type` and
  `response-content-disposition` and are answered as the corresponding response headers.
  `responseContentDisposition` is not checked for ASCII; a name outside ASCII goes in the
  `filename*=UTF-8''…` form of RFC 6266.
- `presignPut` signs `PUT` on a writable key with `content-length`, `content-type` and `host` as
  its signed headers, and returns `headers` holding `content-type`. A body of another length or
  another content type, one differing in case or parameters included, is rejected with
  `403 SignatureDoesNotMatch`. An existing object is overwritten. No length range is signed in.
- `cacheControl`, `contentDisposition` and `contentLanguage` are checked as `put` checks them
  (section 4.3), the content type always counted in the 2,048 bytes, before anything is sent. Each
  one given joins the signed headers as `cache-control`, `content-disposition` or
  `content-language` and is returned in `headers` under that name. GCS answers a value that differs
  from the signed one with `403 SignatureDoesNotMatch` and a missing one with
  `400 MalformedSecurityHeader`, and stores the signed one as sent. A content header left out is
  not bound: whoever holds the URL may send it, and GCS stores it (ADR 0063).
- Every binding is exact up to runs of spaces, which GOOG4 collapses as SigV4 does (section
  7.10).
- An expired URL is answered with `400 ExpiredToken`.
- A URL signed with a local key works until it expires or the key is deleted. One signed through
  `signBlob` may stop working 12 hours after it was signed, whatever `expiresIn` asked for, because
  Google rotates the key behind it.
- The URL is a bearer token: whoever holds it may perform that one operation on that one key until
  it expires. It works against the endpoint that signed it only.
- There is no presigned `POST` and no presigned resumable upload.

## 10. `@stowage/http`

`@stowage/http` is the HTTP layer: it answers a web request on a storage's behalf for a key the
caller has already named, and resolves with a web `Response` (ADR 0046). Routing, authorization,
naming the key, CSRF beyond what the methods of section 10.5 give, and `multipart/form-data` stay
with the caller. Any framework that speaks web `Request` and `Response` reaches stowage through it;
a server that cannot send a web `Response` reaches it through the Node bridge (section 10.7).

### 10.1 Exports

```ts
export interface ServeObjectOptions {
  filename?: string;
  disposition?: "attachment" | "inline";
  cacheControl?: string;
  storedCacheControl?: boolean;
}

export interface RedirectToObjectOptions {
  expiresIn: number;
  filename?: string;
  disposition?: "attachment" | "inline";
}

export interface AcceptUploadOptions {
  maxSize: number;
  contentType?: string;
  cacheControl?: string;
  contentDisposition?: string;
  contentLanguage?: string;
  userMetadata?: Record<string, string>;
}

export interface PresignUploadOptions {
  expiresIn: number;
  maxSize: number;
  contentType: string;
  contentLength: number;
  cacheControl?: string;
  contentDisposition?: string;
  contentLanguage?: string;
}

export interface PresignsGet {
  presignGet(
    key: string,
    options: { expiresIn: number; responseContentDisposition?: string },
  ): Promise<string>;
}

export interface PresignsPut {
  presignPut(
    key: string,
    options: {
      expiresIn: number;
      contentType: string;
      contentLength: number;
      cacheControl?: string;
      contentDisposition?: string;
      contentLanguage?: string;
    },
  ): Promise<PresignedPut>;
}

export function serveObject(
  storage: Storage,
  key: string,
  request: Request,
  options?: ServeObjectOptions,
): Promise<Response>;
export function redirectToObject(
  storage: PresignsGet,
  key: string,
  request: Request,
  options: RedirectToObjectOptions,
): Promise<Response>;
export function acceptUpload(
  storage: Storage,
  key: string,
  request: Request,
  options: AcceptUploadOptions,
): Promise<Response>;
export function presignUpload(
  storage: PresignsPut,
  key: string,
  options: PresignUploadOptions,
): Promise<Response>;

export function storageErrorOf(response: Response): StorageError | undefined;
export function objectStatOf(response: Response): ObjectStat | undefined;

export interface NodeRequest {
  readonly method?: string;
  readonly url?: string;
  readonly headers: Readonly<Record<string, string | readonly string[] | undefined>>;
  readonly socket: object;
  readonly readableDidRead: boolean;
  on(event: "data", listener: (chunk: Uint8Array) => void): unknown;
  on(event: "end", listener: () => void): unknown;
  on(event: "error", listener: (error: Error) => void): unknown;
  pause(): unknown;
  resume(): unknown;
}

export interface NodeResponse {
  statusCode: number;
  readonly writableEnded: boolean;
  readonly writableFinished: boolean;
  readonly destroyed: boolean;
  setHeader(name: string, value: string | readonly string[]): unknown;
  write(chunk: Uint8Array): boolean;
  end(): unknown;
  destroy(error?: Error): unknown;
  on(event: "drain" | "close", listener: () => void): unknown;
}

export function toWebRequest(req: NodeRequest, res: NodeResponse): Request;
export function writeResponse(res: NodeResponse, response: Response): Promise<void>;
```

- `serveObject` and `acceptUpload` take the portable `Storage`. `redirectToObject` and
  `presignUpload` take a structural type naming the one method they call, with the options every
  adapter that declares `presignedUrls` shares: `S3Storage`, `AzureBlobStorage` and a `GcsStorage`
  built with a `signer` satisfy both, and a storage without `presignedUrls` fails to compile. The
  two types are separate, so a storage needs only the one it is used for, and neither moves into
  `@stowage/core` (ADR 0046, ADR 0048, ADR 0049).
- The layer constructs no storage, reads no environment and holds no configuration: the storage
  arrives with every call. It keeps no registry over several storages, offers no hook into an
  adapter's requests and reaches nothing below a concrete type (ADR 0042). It buffers no body.
- No function reads the request's URL. The key is the caller's argument.
- `PresignedPut` is the type of section 4.13.

### 10.2 Answers

- Every function resolves with a `Response`. A `StorageError` an operation rejects with becomes a
  status by what it says about the request, not by the provider's status (ADR 0048):

  | `StorageError`                                         | Status                  |
  | ------------------------------------------------------ | ----------------------- |
  | `NotFound` with `key`, `InvalidKey`                    | `404`                   |
  | `InvalidRequest` from a ranged `get` (section 10.3)    | `416`                   |
  | `NetworkError`, `ProviderError` with `retryable: true` | `503`, no `Retry-After` |
  | every other, `NotFound` without `key` among them       | `500`                   |

  `AccessDenied`, `InvalidCredentials` and `Expired` describe the server's credential, not the
  client's rights, and are `500`. An `InvalidRequest` from `put` over the adapter's part limit is
  `500` too, since it is a `maxSize` beyond what the storage takes.

- The body of an answer made from a `StorageError` is empty: a provider's message names buckets
  and accounts. `storageErrorOf(response)` answers the error behind it, and `undefined` for any
  other `Response` and for a copy of one.
- Anything thrown that is not a `StorageError` is thrown on, an `AbortError` and a programmer error
  among it.
- The refusals of the layer's own, such as `405`, `412`, `413`, `415` and the `400`s of sections
  10.5 and 10.6, carry no `StorageError`.
- The layer promises the answer it hands back, not its delivery. A client still sending a body
  the layer answered without reading, or refused while it streamed, may meet a reset connection
  instead of the answer, as the runtime decides (ADR 0056).
- Every `Response` the layer builds has mutable headers, so the caller sets `Location`, CORS or
  anything else on `response.headers` afterwards. A `302` is built with `new Response(null, …)`,
  not with `Response.redirect()`.
- `storageErrorOf` and `objectStatOf` recognise the layer's answers by the object itself, not by
  `instanceof`, and hold where a server replaces the global `Response` with a subclass, as
  `@hono/node-server` does.
- `request.signal` is passed to every `get`, `stat` and `put` the layer sends. The body of a
  served `Response` is the stream of `get`, so a runtime canceling it on disconnect cancels the
  provider's request (section 4.5).

### 10.3 Serving an object

`serveObject` streams the object through the server from `get` and `stat` (ADR 0048).

- Methods: `GET` and `HEAD`, read from `request.method`, since Hono and Next.js route `HEAD` to
  the `GET` handler. Any other method is `405` with `Allow: GET, HEAD`.
- `HEAD` is answered from `stat` with the headers a `GET` without `Range` would carry and no body.
  `Range` on a `HEAD` is ignored.
- `200` and `HEAD` carry `Content-Length: size` where `contentEncoding` is missing: the bytes `get`
  hands over are then the bytes stored, and `size` comes from the `stat` of that same `get`. Where
  `contentEncoding` is set, the bytes arrive decoded on Node, Bun and `workerd` and as stored on
  Deno through `adapter-s3` and `adapter-azure-blob` (section 4.4), so the answer carries neither
  `Content-Length` nor `Content-Encoding`, and a client sees no total and no progress (ADR 0062).
  Bun and `workerd` may drop the length of a streamed `200` on their way to the socket (section
  2). `Bun.serve` and `Deno.serve` add `Content-Length: 0` to the `HEAD` of a content-coded object,
  which RFC 9110 8.6 forbids and no conformance case reaches, since stowage writes no such object.
- Headers on `200`, `206` and `HEAD`, taken from the `stat` that describes the bytes sent:
  - `Content-Type` as stored.
  - `X-Content-Type-Options: nosniff`, always.
  - `Content-Disposition`: where the caller passes neither `filename` nor `disposition` and the
    object stores a `contentDisposition` whose type, the token before the first `;` compared
    without case, is `attachment`, the stored value as stored. Otherwise, with `disposition`
    `"attachment"`, the default, `attachment; filename="<fallback>"; filename*=UTF-8''<encoded>`.
    The name is `filename` or the key's last segment; a key ending in `/` gets `attachment` alone.
    In the fallback every character outside `U+0020` to `U+007E`, and `"`, `\` and `%`, is replaced
    with `_`; the encoded form is the name's UTF-8 bytes with everything outside RFC 8187's
    `attr-char` percent-encoded. `résumé 100%.pdf` is
    `attachment; filename="r_sum_ 100_.pdf"; filename*=UTF-8''r%C3%A9sum%C3%A9%20100%25.pdf`.
    With `"inline"`, the same parameters follow `inline`. A stored `inline`, or a stored value of
    any other type, is not sent, and the default stands in its place.
  - `Cache-Control`: the stored `cacheControl` where `storedCacheControl` is `true` and the object
    stores one, else `cacheControl` where given, else `private, no-cache`. A stored value is not
    sent without `storedCacheControl`.
  - `Content-Language` as stored, absent where none is stored.
  - `ETag`: the `etag` of the `stat` that describes the bytes sent, quoted as a strong tag. A
    storage that hands over no `etag`, `adapter-fs`, gets no `ETag` and none derived for it.
  - `Date`: the time `serveObject` was called, which the layer sets itself. Bun and Deno write a
    `Date` of their own up to a second behind their clock, and every server keeps the one an
    answer carries.
  - `Last-Modified`: `lastModified` at whole seconds, replaced by the response's `Date` where it is
    later.
  - `Accept-Ranges: bytes` where the storage declares `rangeReads` and `contentEncoding` is
    missing.
- A stored header may be the word of a client that uploaded through a presigned URL, or of another
  tool: the layer sends a stored `Content-Disposition` only where it is an `attachment`, which
  hands the uploader no more than the name a download is saved under, and a stored
  `Cache-Control` only where the caller opts in, since a stored `public` would let a shared cache
  hand one user's object to everyone (ADR 0062).
- `inline` is the caller's explicit choice and risk: an uploaded `text/html` or `image/svg+xml`
  served inline from the application's origin runs with its rights, which `nosniff` does not
  prevent. The layer adds no `Content-Security-Policy`.
- Ranges, where the storage declares `rangeReads`: one range of the unit `bytes`, a suffix range
  included. A satisfiable range is `206` with `Content-Range` and `Content-Length`. An
  unsatisfiable one is `416` with `Content-Range: bytes */<size>`, the size taken from a `stat`
  after the failed `get`. A suffix of length zero is unsatisfiable (RFC 9110 14.1.2) and is `416`
  with the size of the `stat` before it, without a `get`. Any other suffix of an empty object is
  `200` with the whole object, since no `Content-Range` names zero bytes. Several ranges, another
  unit, a malformed header and any `Range` on a storage without `rangeReads` are ignored, and the
  whole object is `200`. There is no `multipart/byteranges`.
- An object whose `contentEncoding` is set takes no range (section 4.3). Where the layer calls
  `stat` before `get`, it ignores the `Range` of such an object, a suffix of length zero included,
  and answers `200` without sending a ranged `get` (ADR 0062). Without that
  `stat`, a ranged `get` that rejects with a `ProviderError` with `retryable: false` is followed by
  one whole `get`, answered `200`. That is the content-coded object of section 4.3, which only the
  error's message tells apart before its description is known, and a genuine provider failure
  fails the second `get` alike.
- Preconditions, per RFC 9110 13.2.2 in its order: `If-Match`, `If-Unmodified-Since`,
  `If-None-Match`, `If-Modified-Since`, `If-Range`. `If-Unmodified-Since` is evaluated only without
  `If-Match`, and `If-Modified-Since` only without `If-None-Match`. `If-Match` and `If-Range`
  compare strongly, `If-None-Match` weakly. Without an `etag`, `If-Match` holds for `*` alone. A
  failed `If-Match` or `If-Unmodified-Since` is `412`; a failed `If-None-Match` or
  `If-Modified-Since` is `304` with the headers of the `200` but `Content-Length`, the content
  headers among them, and no body. `If-Range` with a date never holds, since a date at second
  resolution is no strong validator, and the whole object is sent. Dates compare at whole seconds.
- A request that would be `404` without its preconditions is `404` with them.
- `stat` first: only where the request carries a precondition or a suffix range does the layer call
  `stat` before `get`. It then decides by the `stat` that `get` resolves with, since that one
  describes the bytes sent. The object counts as changed when the `etag`s differ, or, without
  them, `size` or `lastModified`. A changed object has its preconditions evaluated again; where the
  outcome changes, the body is canceled and the new outcome answered, at most with one more whole
  `get`.
- On Deno, `adapter-s3` and `adapter-azure-blob` hand over a content-coded object as stored, so
  the client receives coded bytes without `Content-Encoding` (section 4.4). `contentEncoding` tells
  the layer that the object is coded, not whether the runtime decoded it, so the layer cannot
  repair it (ADR 0061).

### 10.4 Redirecting to an object

`redirectToObject` answers `302` to a URL from `presignGet`, which leaves ranges, preconditions and
a content coding to the provider and serves the bytes from the provider's origin (ADR 0048).

- `GET` and `HEAD` are answered with the same `302`: `Location` the presigned URL,
  `Cache-Control: private, no-store` because the URL expires, and an empty body. Any other method
  is `405` with `Allow: GET, HEAD`.
- `expiresIn` is required and has no default, as on `presignGet`. `filename` and `disposition`
  reach the provider as `responseContentDisposition`, built as in section 10.3 without the stored
  `contentDisposition`, which `redirectToObject` does not consult: it sends no `stat` (ADR 0062).
- The provider answers the client from its own origin with the stored `Cache-Control` and
  `Content-Language`; GCS sends `private, max-age=0` for an object stored without `Cache-Control`.
- A URL from `presignGet` is signed for `GET` on S3 and GCS, so a client following the `302` with
  `HEAD` is answered `403` there. A caller who needs `HEAD` serves through `serveObject`.
- `presignGet` sends no request, so a missing key is the provider's `404` to the client, not the
  layer's.

### 10.5 Accepting an upload

`acceptUpload` streams the request body into `put` (flow 1, ADR 0049).

- Methods: `PUT` alone. Any other is `405` with `Allow: PUT`. A cross-site HTML form cannot send
  `PUT`, and a cross-origin `fetch` with it is preflighted, so the method alone keeps form-based
  CSRF out; a `multipart/form-data` body cannot arrive from a browser form either.
- `maxSize` is required: a non-negative integer or `Infinity`. Any other value rejects with a
  `TypeError` whatever the method, since it is the caller's programmer error. A `Content-Length`
  above it is `413` before the body is read, and one that is no non-negative decimal integer is
  `400` before the body is read. The layer counts the bytes between `request.body` and `put` and errors
  the stream before `put` sees its end once the count passes `maxSize` (`413`) or the body ends
  short of its `Content-Length` or runs past it (`400`). A body that fails while it is read, a
  reset connection among the causes, is `400`. `put` then rejects, and the key is absent or holds
  what it held before (flow 1).
- `contentType` absent: the request's `Content-Type`, and without that header the storage's default
  of section 4.3. User metadata comes from `userMetadata` alone, and the content headers from
  `cacheControl`, `contentDisposition` and `contentLanguage` alone, handed to `put` as given; none
  is read from the request's headers (ADR 0063). A value `put` refuses is the caller's
  `InvalidOption` or `InvalidRequest`, answered `500`, as for `contentType`. A
  `Content-Encoding` other than `identity` is `415`, since no runtime decodes a request body. Any
  check of the content type is the caller's, made on the request's headers before the call.
- A client still sending a body the layer refused, by `405`, `413`, `415` or `400`, may meet a reset
  connection instead of the refusal (section 10.2).
- A request whose `body` is `null` stores an empty object.
- `request.bodyUsed` being `true` rejects with a `TypeError` before `put` starts, rather than storing an
  empty or partial body. A body read before the call is the caller's programmer error and not a
  `StorageError` (ADR 0052).
- A stored object is `201` with an empty body and the `etag` `put` resolved with as a quoted strong
  `ETag`, none where the storage hands over none. `201` is sent whether or not the key held an
  object before. `objectStatOf(response)` answers the `ObjectStat` `put` resolved with, and
  `undefined` for any other `Response` and for a copy of one. The body carries no `ObjectStat`.
- A `StorageError` becomes a status by section 10.2.

### 10.6 Presigning an upload

`presignUpload` answers with what `presignPut` returns (flow 2, ADR 0049). It takes no `Request`:
the caller names the key first, usually from the request body, and hands over the values the client
sent.

- `expiresIn`, `maxSize`, `contentType` and `contentLength` are required; `cacheControl`,
  `contentDisposition` and `contentLanguage` are optional, handed to `presignPut` where given, and
  never read from a request. Before signing, a `contentLength` that is not a non-negative integer
  is `400`, one above `maxSize` is `413`, a `contentType` that `isHeaderValue` of section 4.13
  refuses is `400`, and content headers that break the form or a bound of section 4.3 are `400`,
  the bounds included, which concern no body. So a client's value never reaches `presignPut` as an
  `InvalidOption` or `InvalidRequest` answered `500` (ADR 0063). A storage that does not declare
  `contentHeaders` refuses the three in `presignPut`, answered `500`.
- A signed upload is `200` with `Content-Type: application/json`,
  `Cache-Control: private, no-store` and the body `{ "url", "method": "PUT", "headers" }`, `headers`
  being what `presignPut` returns.
- A `StorageError` becomes a status by section 10.2.

### 10.7 The Node bridge

The Node bridge carries a web `Request` and `Response` over the protocol of `node:http`'s request
and response, on Node, Bun and Deno (ADR 0046). It imports no `node:` module, so the package loads
on `workerd`, where it has nothing to do. Express, with or without NestJS, and Fastify through
`reply.hijack()` and `reply.raw` reach the layer through it; neither is named as a promised
framework. `IncomingMessage` and `ServerResponse` of `node:http` satisfy `NodeRequest` and
`NodeResponse`, and so do an Express request and response.

- `toWebRequest(req, res)` builds a `Request` with the method and headers of `req`, a URL of
  `https:` where `req.socket` is encrypted and `http:` otherwise, the `Host` header, `localhost`
  without one, and `req.url`. Its body streams `req` with backpressure for any method but `GET`
  and `HEAD`, which carry none.
- Its `signal` aborts once `res` closes before it has finished, which is a client disconnecting.
  The request's own `close` is not the signal, since Node emits it as soon as the body is read and
  an upload may still be completing. Where the body of `req` is still streaming then, the body
  fails before the signal aborts: Node closes the response of a reset connection before the
  request emits its error, and `acceptUpload` answers the failed body with `400` (section 10.5)
  rather than throwing on the abort.
- A `req` whose body was already read, by `express.json()` or NestJS's default body parsers among
  others, makes `toWebRequest` throw a `TypeError` rather than hand the layer an empty body (ADR
  0051).
- `writeResponse(res, response)` writes the status and headers, then the body chunk by chunk,
  waiting for `drain`. A `HEAD` answer and a `304` carry no body. It resolves once the response has
  ended. A client disconnecting cancels the body and resolves; a body that errors destroys `res`,
  so the client sees an incomplete answer rather than a complete short one, and rejects with that
  error. That the request was a `HEAD` it learns from `toWebRequest` on the same `res`; without
  that call it writes the body it is handed, which no answer of the layer carries for a `HEAD`.
- Once `writeResponse` has ended the response, a request body that no read of the `Request` asked
  for, the body of a `413` by `Content-Length` among them, is let flow and dropped.
- A client that left before `toWebRequest` or `writeResponse` was called is read from
  `res.destroyed`, since a closed `res` emits no `close` for a listener added later and answers
  every `write` with `false` and no `drain`. The signal of `toWebRequest` is then aborted when the
  `Request` is built, and `writeResponse` cancels the body and resolves. Node, Bun and Deno set
  `destroyed` on such a response; Deno sets no `closed`.

## 11. `@stowage/nestjs`

`@stowage/nestjs` wires a storage into a NestJS 12 application and serves it through
`@stowage/http` on Express and on Fastify (ADR 0051).

```ts
import type {
  DynamicModule,
  ForwardReference,
  InjectionToken,
  OptionalFactoryDependency,
  Type,
} from "@nestjs/common";

export interface StorageModuleOptions {
  provide: InjectionToken;
  storage: Storage;
  global?: boolean;
}

export interface StorageModuleAsyncOptions {
  provide: InjectionToken;
  useFactory: (...args: any[]) => Storage | Promise<Storage>;
  inject?: (InjectionToken | OptionalFactoryDependency)[];
  imports?: (Type | DynamicModule | Promise<DynamicModule> | ForwardReference)[];
  global?: boolean;
}

export class StorageModule {
  static forRoot(options: StorageModuleOptions): DynamicModule;
  static forRootAsync(options: StorageModuleAsyncOptions): DynamicModule;
}

export function webRequestOf(req: unknown, res: unknown): Request;
export function sendResponse(res: unknown, response: Response): Promise<void>;
```

- One registration holds one storage under the injection token `provide`, which the caller passes.
  There is no default token, none is derived from a name, and two storages are two registrations.
  The application injects with `@Inject(token)` in its own code; the package exports no
  `InjectStorage` and no token.
- `forRootAsync`'s factory returns the storage itself, with no options object in between. There is
  no `useClass` and no `useExisting`.
- `global` defaults to `true`, so a feature module importing the module again does not construct a
  second storage. `global: false` keeps the token to the importing module.
- The module has no lifecycle hook, offers no fake and no `forTesting`. A test replaces a storage
  with `overrideProvider(token).useValue(…)`.
- `webRequestOf(req, res)` builds the `Request` of section 10.7 from an Express request and response,
  or from a Fastify request and reply through their `raw`. `sendResponse(res, response)` writes a
  `Response` into an Express response, or into a Fastify reply's `raw` after calling
  `reply.hijack()` itself. Both tell the platforms apart by shape and import neither `express` nor
  `fastify`, so a handler reads the same on both platforms:
  `await sendResponse(res, await serveObject(storage, key, webRequestOf(req, res)))`.
- A controller takes `@Req()` and `@Res()`, the latter without `passthrough`, since NestJS cannot
  send a web `Response` itself.
- The package registers no Fastify content type parser and exports no parameter decorator for the
  web `Request`.
- stowage's sources hold no decorator syntax; the package calls NestJS's decorator functions
  directly (ADR 0047).

## 12. `@stowage/hono`

`@stowage/hono` wires a storage into a Hono 4 application on all four runtimes (ADR 0052).

```ts
import type { Context, Env, MiddlewareHandler } from "hono";

export function withStorage<K extends string, S extends Storage, E extends Env = Env>(
  name: K,
  storage: S | ((c: Context<E>) => S | Promise<S>),
): MiddlewareHandler<{ Variables: { [k in K]: S } }>;
```

- One call sets one storage on `c.var[name]`, under the name the caller passes. There is no
  default name, and two storages are two calls.
- `storage` is a constructed storage or a function called on every request, without caching. On
  `workerd` the function builds the storage from `c.env`; its `Bindings` come from its annotated
  parameter.
- `c.var[name]` keeps the concrete type, so `redirectToObject` and `presignUpload` compile on an
  `S3Storage` without a cast. The package does not augment `ContextVariableMap`.
- The package exports nothing else: no route factory, no `onError` handler, no override and no
  fake. It detects no runtime. A route serves through `@stowage/http` with `c.req.raw`, such as
  `serveObject(c.var.avatars, key, c.req.raw)`; `c.req.raw.method` stays `"HEAD"` where Hono routes
  a `HEAD` to the `GET` handler.
- No integration re-exports `@stowage/http`; the application installs it beside the integration.

## 13. `@stowage/nextjs`

`@stowage/nextjs` wires a storage into a Next.js 16 application on Node (ADR 0053).

```ts
export function lazyStorage<S extends Storage>(factory: () => S): () => S;
```

- `lazyStorage(factory)` returns a getter that runs `factory` on its first call and keeps the
  storage for the module instance it lives in, so `next build` constructs nothing until a request
  asks. Not on `globalThis`: one process may hold one storage per module graph, which costs no I/O,
  since a storage holds nothing between calls (section 4.1).
- One call holds one storage, with no name. Two storages are two calls.
- The factory is synchronous; a factory returning a `Promise` does not type-check. A factory that
  throws is not cached: every call runs it again.
- The getter keeps the concrete type, so `redirectToObject` and `presignUpload` compile on an
  `S3Storage` without a cast.
- The package imports nothing from `next`. It keeps the peer dependency on `next`, which carries the
  promise of Next.js 16 on Node (section 2).
- It exports nothing else: no `params` helper, no presign helper, no override and no fake. No adapter
  sets `cache: 'no-store'` on its requests.
- A Next.js Proxy matching an upload route cuts a chunked body at `proxyClientMaxBodySize`, and
  `acceptUpload` cannot tell the cut body apart from a complete one (section 10.5).

## 14. `@stowage/conformance`

### 14.1 Exports

```ts
export interface ConformanceTarget {
  readonly name: string;
  createStorage(): Storage | Promise<Storage>;
  cleanup?(keyPrefix: string): Promise<void>;
  createStorageWithBadCredentials?(): Storage | Promise<Storage>;
  createStorageWithExpiredCredentials?(): Storage | Promise<Storage>;
  createStorageWithDeniedCredentials?(): Storage | Promise<Storage>;
  createStorageWithMissingBucket?(): Storage | Promise<Storage>;
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

### 14.2 Running the suite

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
  (ADR 0023). For `adapter-gcs` it is a storage built with a `signer`: a key the harness generates
  against fake-gcs-server, and `signBlob` against the real bucket (ADR 0034, ADR 0035).
- A case whose `requires` are all declared runs `run`; a case missing one runs `runWithout`. The
  result says which half ran in `mode`. A case that needs an optional factory the target does not
  supply reports `skipped` with the factory's name as `reason`.
- `runAll` normalizes a thrown value to `name` and `message`, adds `stack` where present and `code`
  where the value is a `StorageError`. It never exposes `cause`.
- `expectUnsupported(call, capability)` runs `call` and asserts a `StorageError` with
  `code: "Unsupported"` and that `capability`.

### 14.3 What the target promises

- `createStorage()` returns a storage the run may write to below any prefix, constructed from
  outside the adapter. What it supports the suite reads from the storage.
- `createStorageWithBadCredentials()` returns a storage whose credential the provider refuses.
- `createStorageWithExpiredCredentials()` returns a storage whose credential has already expired.
- `createStorageWithDeniedCredentials()` returns a storage whose credential the provider accepts
  and that may read the bucket and not write to it.
- `createStorageWithMissingBucket()` returns a storage bound to a bucket, container or root that
  does not exist and is otherwise configured as the storage of `createStorage()`.

### 14.4 What the suite does not assert

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
- The account key of `adapter-azure-blob`, which the suite does not run under (section 14.2): Shared
  Key signatures across the operations of the parity core, with user metadata named `a1` and `a_`
  and a value holding a run of spaces, and the content headers of `put/content-headers`, a tab and a
  run of spaces among them, on `Put Blob` and on `Put Block List`; `presignGet` as a service SAS;
  `presignPut` refused before any request; and a `copy`, once the pinned Azurite carries `Put Blob
From URL`. Against Azurite on every commit and the account in the `slow` tier.
- The refresh of `adapter-s3` after `SignatureDoesNotMatch` under a session token (section 7.3),
  against a stubbed `fetch`: one resolver call with `forceRefresh: true`, then success, or
  `InvalidCredentials` with `attempts: 2` after a second one; one attempt for the same answer to a
  key pair.
- The `GET` that reads a refused `HEAD` of `adapter-s3` (section 7.9), against a stubbed `fetch`: a
  key pair refused as `InvalidCredentials` with `attempts: 1` in two requests; a session token
  refused as `SignatureDoesNotMatch`, then one resolver call with `forceRefresh: true` and the `HEAD`
  sent again, which succeeds, or `InvalidCredentials` with `attempts: 2` where the refreshed `GET`
  is refused too; `AccessDenied` in two requests; and the describing `HEAD` of `copy`.
- A session token `adapter-s3`'s provider cannot parse (sections 7.3 and 7.9), against a stubbed
  `fetch`: AWS's `InvalidToken` and R2's `InvalidArgument` naming `X-Amz-Security-Token`, each
  answered to the `GET` after the `HEAD` of `stat`, are `InvalidCredentials` with `attempts: 1` and
  no refresh.
- The repeat after `401 InvalidAuthenticationInfo` under an access token (section 8.3), against a
  stubbed `fetch`: one resolver call with `forceRefresh: true`, then success, or
  `InvalidCredentials` after a second `401`.
- `Put Block List` sent again after a lost response with the headers it carried, against a stubbed
  `fetch`; the same commit sent twice answering `201` and leaving the same bytes, and a `Put Blob`
  discarding the uncommitted blocks of its name, against the account in the `slow` tier.
- The CORS headers on the `403` for an expired presigned URL on Azure, after a preflight from the
  origin the account's rule allows, in the `slow` tier.
- The signature of `adapter-gcs`'s local signer, against Google's 40 RSA V4 vectors on every
  commit, and its URLs against the real bucket through `signBlob` in the `slow` tier.
- The two response overrides on `presignGet` of `adapter-gcs` (section 9.9), and the CORS headers
  on the `400` for an expired presigned URL on GCS after a preflight from the origin the bucket's
  rule allows, against the real bucket in the `slow` tier.
- The repeat after `401` with `error=invalid_token` on `adapter-gcs` (section 9.3), against a
  stubbed `fetch`: one resolver call with `forceRefresh: true`, then success, or
  `InvalidCredentials` after a second `401`. Against the real bucket in the `slow` tier, the answer
  to a token past its expiry and the repeat recovering from it.
- The answers of GCS to a resource request and a media download pinned to a generation a writer
  replaced (section 9.4), against the real bucket in the `slow` tier.
- A resumable session on GCS (section 9.6), against a stubbed `fetch` answering as the service
  did: a chunk sent again whole after a lost answer, a short acknowledgement answered with the rest
  of the part, a `308` that acknowledges nothing spending an attempt, a repeated commit, and the
  cancel after an unanswered commit meeting a committed and an open session.
- The `rewriteTo` loop of `copy` on GCS (section 9.7), against a stubbed `fetch`: a token carried
  to the next call, a `404` on a continued call, an abort between two calls.
- The reading of failures on GCS (section 9.8), against a stubbed `fetch`: the body rule, a `404`
  without a provider code, a missing bucket on every operation, `get` with one of its two requests
  failed, a media `416`, a forged cursor, and `requestId` on a resumable session.
- The refusal of a range on an object stored with a content coding (section 4.3) on `adapter-s3`
  and `adapter-azure-blob`, which stowage cannot write: against a stubbed `fetch`, a `206` and a
  `200` naming a coding, the body canceled, and `identity` read as no coding; in each adapter's
  harness, an object written with `Content-Encoding: gzip` through a signed `PUT` of the harness's
  own, whose `size` is the stored size, whose whole `get` resolves and whose range is
  `ProviderError`.
- `contentEncoding` of such an object (section 4.4) on `adapter-s3`, `adapter-azure-blob` and
  `adapter-gcs`: in the same harness tests, `stat`, `get` and `copy` report the coding as written;
  against a stubbed `fetch`, `identity`, an empty value and `GZIP` (ADR 0061, ADR 0064).
- The refusal of an upload whose `x-ms-blob-content-type` differs from the one a URL of
  `presignPut` binds, on `adapter-azure-blob` against the account in the `slow` tier (ADR 0063).
- The divergences of each emulator from the provider it stands in for, kept as a list in the
  private harness (ADR 0012, ADR 0023, ADR 0034).

### 14.5 Cases

Names are stable: a renamed case is a removed case and an added one. `fast` cases run on every
pull request. A case with `requires` carries a `runWithout` half, described in the last column.
A case marked with a factory is skipped where the target does not supply it.

**Declaration**

| Case                      | Requires | Cost   | Asserts                                                             |
| ------------------------- | -------- | ------ | ------------------------------------------------------------------- |
| `declaration/valid-names` |          | `fast` | `capabilities` holds only names out of `capabilityNames`, each once |
| `declaration/identity`    |          | `fast` | `provider` and `bucket` are non-empty strings                       |

**`put`**

| Case                            | Requires                                | Cost   | Asserts                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| ------------------------------- | --------------------------------------- | ------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `put/bytes-round-trip`          |                                         | `fast` | A `Uint8Array` reads back byte for byte through `bytes()`; the returned `ObjectStat` and a later `stat` agree on `key`, `size` and `contentType`                                                                                                                                                                                                                                                                                                                                                                                                             |
| `put/string-round-trip`         |                                         | `fast` | A string with characters above ASCII reads back equal through `text()`; `size` is its UTF-8 length                                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| `put/stream-round-trip`         |                                         | `fast` | A 1 MiB stream reads back byte for byte                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| `put/multipart-round-trip`      |                                         | `fast` | A 17 MiB stream of a generated pattern reads back byte for byte; `stat` reports the size                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| `put/empty-body`                |                                         | `fast` | An empty `Uint8Array` and a stream that yields nothing both produce an object of size 0 that reads back empty                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| `put/overwrites`                |                                         | `fast` | A second `put` under the same key replaces bytes and content type                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| `put/content-type-stored`       |                                         | `fast` | `contentType: "text/plain"` on a key ending in `.txt` is reported by `stat` and `get`                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| `put/content-type-default`      |                                         | `fast` | Without `contentType`, a key without an extension reports `application/octet-stream`                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| `put/accepted-keys`             |                                         | `fast` | Each key of the accepted list (section 14.7) round-trips and is listed under its prefix                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| `put/refused-keys`              |                                         | `fast` | Each key of the refused writable list rejects with `InvalidKey`, `attempts: 0`, and `exists` afterwards is `false` where the key is addressable, or rejects with `InvalidKey` for a key the provider cannot hold (section 14.7)                                                                                                                                                                                                                                                                                                                              |
| `put/unknown-option`            |                                         | `fast` | An unknown option key rejects with `InvalidOption` whose message names the key; nothing was written                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| `put/aborted-signal`            |                                         | `fast` | A signal already aborted rejects with `AbortError`; nothing was written                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| `put/abort-during-upload`       |                                         | `fast` | Aborting during a 17 MiB stream rejects with `err.name === "AbortError"` and not a `StorageError`                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| `put/stream-consumed`           |                                         | `fast` | After `put`, the source stream is closed or canceled; reading it yields `done`                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| `put/user-metadata`             | `userMetadata`                          | `fast` | Two entries with identifier keys round-trip through `stat` and `get`, keys compared case-insensitively. Without: a non-empty object is `Unsupported` naming `userMetadata`; `{}` passes and reads back `{}`                                                                                                                                                                                                                                                                                                                                                  |
| `put/user-metadata-limits`      | `userMetadata`                          | `fast` | A key with a character above ASCII, a value holding a lone surrogate and a set of identifier keys over 2 KB each reject with `InvalidRequest`, `attempts: 0`. Without: all three are `Unsupported`                                                                                                                                                                                                                                                                                                                                                           |
| `put/user-metadata-token-keys`  | `userMetadata`, `userMetadataTokenKeys` | `fast` | A key `content-hash` round-trips through `stat` and `get`. Without: it is `Unsupported`, `attempts: 0`, naming `userMetadataTokenKeys` where `userMetadata` is declared and `userMetadata` where it is not                                                                                                                                                                                                                                                                                                                                                   |
| `put/content-headers`           | `contentHeaders`                        | `fast` | `cacheControl` `public, max-age=60, immutable`, a `contentDisposition` holding a tab and a run of spaces, and `contentLanguage` `de-AT, en` read back byte for byte through the `ObjectStat` of `put`, through `stat` and through `get`; a second `put` without them reports none; no `ObjectStat` carries `contentEncoding`. Without: each of the three alone, `""` included, is `Unsupported` naming `contentHeaders`, `attempts: 0`, and leaves no object; an object written without them reports all three absent, not present as `undefined`            |
| `put/content-headers-multipart` | `contentHeaders`                        | `fast` | The three on a 17 MiB stream read back byte for byte through the `ObjectStat` of `put` and through `stat`, without `contentEncoding`. Without: the `put` is `Unsupported` naming `contentHeaders` and leaves no object                                                                                                                                                                                                                                                                                                                                       |
| `put/content-headers-refused`   | `contentHeaders`                        | `fast` | A value that is no string, `""`, one with a space at either end, one holding a line feed and one holding `ü` each reject with `InvalidOption` naming the option, `attempts: 0`; 2,049 bytes with `Content-Type` and a `contentLanguage` of 101 characters each reject with `InvalidRequest`, `attempts: 0`; nothing was written. Exactly 2,048 bytes with `Content-Type`, the padding in `contentDisposition`, and exactly 100 characters of `contentLanguage` are stored and read back. Without: every one of them is `Unsupported` naming `contentHeaders` |
| `put/concurrent-writers`        |                                         | `fast` | Two streamed `put`s of 17 MiB, one of a pattern A and one of a pattern B, paced so that each has sent a part before either completes: each resolves or rejects, at least one resolves, and `get` returns A or B byte for byte                                                                                                                                                                                                                                                                                                                                |

**`get`**

| Case                      | Requires     | Cost   | Asserts                                                                                                                                 |
| ------------------------- | ------------ | ------ | --------------------------------------------------------------------------------------------------------------------------------------- |
| `get/missing-key`         |              | `fast` | Rejects with `NotFound`, `key` set, `operation: "get"`, `retryable: false`, `attempts: 1`                                               |
| `get/stream`              |              | `fast` | `stream()` yields the bytes; canceling it does not reject                                                                               |
| `get/text-and-json`       |              | `fast` | `text()` decodes UTF-8; `json()` parses; a body that is not JSON rejects `json()` with `SyntaxError` and not a `StorageError`           |
| `get/body-read-once`      |              | `fast` | A second reader after `bytes()` rejects with `InvalidRequest`                                                                           |
| `get/stat-from-response`  |              | `fast` | `stat` on the stored object equals `stat()` in `key`, `size`, `contentType`, `etag`                                                     |
| `get/addressable-keys`    |              | `fast` | A key ending in `/` and a key holding a backslash reject with `NotFound`, not `InvalidKey`                                              |
| `get/refused-keys`        |              | `fast` | Each key of the refused addressable list (section 14.7) rejects `get`, `stat` and `exists` with `InvalidKey`, `attempts: 0`             |
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

| Case                   | Requires         | Cost   | Asserts                                                                                                                                                                                                                                                                                                                             |
| ---------------------- | ---------------- | ------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `copy/round-trip`      |                  | `fast` | Destination has the bytes and content type; source is unchanged; the returned `ObjectStat` names the destination                                                                                                                                                                                                                    |
| `copy/overwrites`      |                  | `fast` | A destination that exists is replaced                                                                                                                                                                                                                                                                                               |
| `copy/missing-source`  |                  | `fast` | Rejects with `NotFound`; no destination is created                                                                                                                                                                                                                                                                                  |
| `copy/onto-itself`     |                  | `fast` | `from === to` rejects with `InvalidRequest`, `attempts: 0`; the object is unchanged                                                                                                                                                                                                                                                 |
| `copy/invalid-keys`    |                  | `fast` | A destination ending in `/` and a source with a `..` segment each reject with `InvalidKey` before anything changes                                                                                                                                                                                                                  |
| `copy/user-metadata`   | `userMetadata`   | `fast` | The destination carries the source's metadata under identifier keys. Without: the copy succeeds and the destination reads `{}`                                                                                                                                                                                                      |
| `copy/content-headers` | `contentHeaders` | `fast` | The destination reports the source's `cacheControl` and `contentDisposition` byte for byte and its `contentLanguage` as the same list, whitespace around its commas possibly removed, through the `ObjectStat` of `copy` and through `stat`, without `contentEncoding`. Without: the copy succeeds and the destination reports none |
| `move/round-trip`      |                  | `fast` | Destination has the bytes and content type; source is gone; the result names the destination                                                                                                                                                                                                                                        |
| `move/missing-source`  |                  | `fast` | Rejects with `NotFound`, `operation: "move"`; no destination is created                                                                                                                                                                                                                                                             |
| `move/content-headers` | `contentHeaders` | `fast` | As `copy/content-headers`, through the `ObjectStat` of `move` and through `stat`; the source is gone. Without: the move succeeds and the destination reports none                                                                                                                                                                   |

**Errors**

| Case                         | Requires | Cost   | Asserts                                                                                                                                                                                                       |
| ---------------------------- | -------- | ------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `errors/shape`               |          | `fast` | Every error the run provokes passes `isStorageError`, has a `code` out of the union, `operation`, `bucket` and `provider` matching the storage, a boolean `retryable` and an integer `attempts`               |
| `errors/not-a-storage-error` |          | `fast` | `AbortError` and `SyntaxError` from the cases above fail `isStorageError`                                                                                                                                     |
| `errors/bad-credentials`     |          | `fast` | Factory `createStorageWithBadCredentials`: `get` and `stat` reject with `InvalidCredentials`, `retryable: false` and `attempts` of `1` or `2`; `exists` rejects rather than answering `false`; `list` rejects |
| `errors/denied-credentials`  |          | `fast` | Factory `createStorageWithDeniedCredentials`: `put` rejects with `AccessDenied`, `retryable: false`, `attempts: 1`                                                                                            |
| `errors/expired-credentials` |          | `slow` | Factory `createStorageWithExpiredCredentials`: `get` and `stat` reject with `Expired` and `attempts: 2`                                                                                                       |
| `errors/missing-bucket`      |          | `fast` | Factory `createStorageWithMissingBucket`: `put`, `get`, `stat`, `exists`, `delete` and the first page of `list` reject; where the code is `NotFound`, `key` is unset                                          |

**Presigned URLs**

| Case                                  | Requires                          | Cost   | Asserts                                                                                                                                                                                                                                                                                                                                                                               |
| ------------------------------------- | --------------------------------- | ------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `presign/get`                         | `presignedUrls`                   | `fast` | `fetch` on the URL answers `200`, the bytes and the content type. Without: `"presignGet" in storage` and `"presignPut" in storage` are both `false`                                                                                                                                                                                                                                   |
| `presign/put`                         | `presignedUrls`                   | `fast` | `fetch` with `PUT`, the returned `headers` and a body of the signed length answers `2xx`; `stat` reports the type and size. Without: as above                                                                                                                                                                                                                                         |
| `presign/expires-in-bounds`           | `presignedUrls`                   | `fast` | `expiresIn` of 0 and of 604801 reject with `InvalidOption`; no request is made. Without: as above                                                                                                                                                                                                                                                                                     |
| `presign/put-rejects-type`            | `presignedUrls`                   | `slow` | A body with another content type answers `403`. Without: as above                                                                                                                                                                                                                                                                                                                     |
| `presign/put-rejects-length`          | `presignedUrls`                   | `slow` | A body of another length answers `4xx`. Without: as above                                                                                                                                                                                                                                                                                                                             |
| `presign/expired-url`                 | `presignedUrls`                   | `slow` | A URL signed with `expiresIn: 1`, called after two seconds, answers `400` or `403`, while a URL signed with `expiresIn: 60` in the same case answers `200`. Without: as above                                                                                                                                                                                                         |
| `presign/put-content-headers`         | `presignedUrls`, `contentHeaders` | `fast` | `presignPut` with the three; `fetch` with `PUT`, the returned `headers` and a body of the signed length answers `2xx`; `stat` reports the three byte for byte and no `contentEncoding`. Without `presignedUrls`: as above. Without `contentHeaders`: `presignPut` with one of the three rejects with `Unsupported` naming `contentHeaders`, `attempts: 0`, and one without them signs |
| `presign/put-rejects-content-headers` | `presignedUrls`, `contentHeaders` | `slow` | Under a URL signed with the three, an upload sending one of them with another value and an upload leaving one out each answer `4xx`. Without: as `presign/put-content-headers`                                                                                                                                                                                                        |

### 14.6 Reference flow cases

| Case                        | Requires        | Cost   | Asserts                                                                                                                                                                                |
| --------------------------- | --------------- | ------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `flow/1-large-upload`       |                 | `fast` | A 17 MiB stream with a content type is stored and reads back byte for byte; an abort during a second upload of the same size rejects with `AbortError` and leaves the key absent       |
| `flow/2-presigned-put`      | `presignedUrls` | `fast` | Sign for a reported length and type, upload with `fetch` and the returned `headers`, `stat` reports both. Without: the methods are absent                                              |
| `flow/3-file-browser`       |                 | `fast` | A tree of 7 objects in 3 pseudo-directories: one `page()` with `/` and `pageSize: 5` returns the level's objects and the 3 prefixes; a new listing with the cursor completes the level |
| `flow/4-streaming-download` | `rangeReads`    | `fast` | `get` with a range streamed into a `Response` yields the range's bytes and the content type. Without: `get` without a range streams the whole object, and a range is `Unsupported`     |
| `flow/5-prefix-move`        |                 | `fast` | Every object below one prefix is streamed from `get` into `put` below another prefix with its content type; `deleteAll` on the source reports their count; the target lists them all   |

### 14.7 Key lists

Every adapter accepts each key of the accepted list for `put` and refuses each key of the refused
lists for the rule named. A key is given as its characters; its length is measured in UTF-8 bytes.

- Accepted: `a`; `hello world.txt`; `docs/2026/report.pdf`; `a#b`; `100%`; `q?x=1`; `a+b`;
  `it's`; `Grüße/日本語/ключ.txt`; a key of 1024 bytes in segments of at most 255 bytes; a key of
  exactly 255 bytes in one segment.
- Refused as writable: the empty string; `/a`; `a/`; `a//b`; `./a`; `a/../b`; `..`; `a\b`; a key
  holding `U+0000`; a key holding `U+001F`; a key holding `U+007F`; `a\uD800b` and `a\uDC00b`, a
  key holding a lone high and a lone low surrogate; a key of 1025 bytes.
- Refused as addressable: the empty string; `/a`; `a//b`; `./a`; `a/../b`; `.`; a key holding
  `U+0000`; `a\uD800b`; `a\uDC00b`.
- Accepted as addressable and refused as writable: `a/`; `a\b`; a key of 1025 bytes.

Accepted means the core's check passes and the request goes out. A provider may still refuse an
addressable key it cannot hold: S3 answers a key above 1024 bytes with `KeyTooLongError`, which
`adapter-s3` reports as `InvalidKey`, and `adapter-azure-blob` reports Azure's `400` for a name
above 1,024 characters the same way. GCS answers such a key with `404 notFound`, which
`adapter-gcs` reports as `NotFound`, so `exists` answers `false` for it. The accepted list holds on
Azure and GCS unchanged. `adapter-fs` refuses the key of 1024 bytes where the file
system's path limit does not hold it below the root, which section 6 states, and its cells leave
`list/noncharacter-key` unrun where the file system refuses the name that case writes.
`adapter-azure-blob` leaves the same case unrun against Azurite, which answers a listing of such a
name with `500`; the account runs it on Node and `workerd`. `adapter-gcs` leaves it unrun against
both of its endpoints, since GCS refuses the key the case writes (section 9.1, ADR 0034).

### 14.8 The HTTP conformance suite

The HTTP conformance suite is a second list of cases in this package. It asserts what a client
observes over HTTP from a server that answers through `@stowage/http`: the statuses, headers and
bodies of section 10 (ADR 0050).

```ts
export interface HttpConformanceTarget {
  readonly name: string;
  createStorage(): Storage | Promise<Storage>;
  url(answer: "serve" | "redirect" | "upload" | "presign", key: string): URL;
  cleanup?(keyPrefix: string): Promise<void>;
}

export interface HttpConformanceContext {
  readonly storage: Storage;
  readonly keyPrefix: string;
  readonly target: HttpConformanceTarget;
  declares(name: CapabilityName): boolean;
}

export type HttpConformanceCase =
  | {
      readonly name: string;
      readonly requires: readonly [];
      readonly cost: "fast" | "slow";
      run(ctx: HttpConformanceContext): Promise<void>;
    }
  | {
      readonly name: string;
      readonly requires: readonly [CapabilityName, ...CapabilityName[]];
      readonly cost: "fast" | "slow";
      run(ctx: HttpConformanceContext): Promise<void>;
      runWithout(ctx: HttpConformanceContext): Promise<void>;
    };

export const httpConformanceCases: readonly HttpConformanceCase[];

export function describeHttpConformance(
  target: HttpConformanceTarget,
  framework: ConformanceFramework,
): void;
```

- The cases are client code. A case seeds and reads objects through the storage of
  `createStorage()`, and sends its own request with `fetch` to `url(answer, key)`, its method,
  headers, `HEAD` and abort included. The suite needs `fetch` and a `Storage` and nothing else, so
  `@stowage/conformance` depends on neither `@stowage/http` nor a framework.
- `createStorage()` returns a storage that addresses the objects the server serves. `url` names the
  route that gives one answer for one key; how the key travels in the URL is the target's.
- The `serve`, `redirect` and `upload` routes hand each method the cases send, `GET`, `HEAD`,
  `POST`, `PUT` and `DELETE`, to the layer, so that the layer answers `405` itself. The `presign`
  route itself answers non-`POST` methods with `405` and `Allow: POST`. The suite fixes what each
  route is configured with:
  - `serve`: `serveObject(storage, key, request)`, without options.
  - `redirect`: `redirectToObject(storage, key, request, { expiresIn: 60 })`.
  - `upload`: `acceptUpload(storage, key, request, { maxSize: 1048576 })`.
  - `presign`: on `POST`, reads the JSON body `{ "contentType", "contentLength" }` and answers
    `presignUpload(storage, key, { expiresIn: 60, maxSize: 1048576, contentType, contentLength })`
    with both values as the body holds them. This is the target's route, not a protocol of the
    layer (section 10.6).
- `describeHttpConformance(target, { describe, test })` maps every case onto Vitest, `bun:test` or
  `Deno.test` as section 14.2 does, inside a `describe` named `<name> over HTTP`. A case name is
  unique within its list: `presign/put` of section 14.5 and of section 14.9 are two cases of two
  lists. There is no `runAll` beside it: on `workerd` only the server runs inside the runtime, and
  the cases run in the Node harness.
- The run's `keyPrefix`, its `cleanup`, the declaration read once per run and the choice between
  `run` and `runWithout` follow section 14.2. What the storage of `createStorage()` declares stands
  for the server behind it.

The suite asserts what a client observes over HTTP. The following are promises of this
repository's servers, tested in this repository and not by the suite:

- A client disconnecting cancels the stream `get` returned and reaches the provider (flow 4), on
  every runtime of every cell of section 2's second table. A cell this fails on carries no "yes".
- Memory stays flat through an upload and a download through each server, on Node.
- The status table of section 10.2, the whole `get` after a ranged `ProviderError`, an object
  changing between `stat` and `get`, and the answer for an object whose `contentEncoding` is set,
  without `Content-Length` and `Accept-Ranges` and planned `200` without a ranged `get` where a
  `stat` comes first (section 10.3), against a storage that answers so, since no endpoint in CI
  produces a content-coded object or a race on demand.
- Option handling that does not depend on the runtime, which a case would reach only through a new
  route or a new duty of the target's routes: the order of `storedCacheControl`, `cacheControl` and
  the default (section 10.3); `acceptUpload` handing its content headers to `put` and reading none
  from the request (section 10.5); `presignUpload` handing its content headers to `presignPut` and
  answering `400` for a value outside the form or a bound (section 10.6) (ADR 0064).
- The `400` of `acceptUpload` for a body that ends short of its `Content-Length` and for a body
  that fails while it is read, over a raw socket: `fetch` cannot send a `Content-Length` that
  contradicts its body. A body that runs past its `Content-Length` is tested as a web `Request`,
  since `node:http` reads the bytes after it as the next request and the layer never sees them.
- The Node bridge on Node, Bun and Deno: the `TypeError` for a body already read, the signal of
  `toWebRequest` aborting when the response closes early and not when the request body ends, and
  `writeResponse` destroying the response for a body that errors.
- `storageErrorOf` and `objectStatOf` answering `undefined` for a copy of an answer.
- `attachment` alone for a key ending in `/`, which `put` writes on no adapter.

### 14.9 HTTP cases

Names are stable, as in section 14.5. Every case is `fast` and runs on every pull request. A case
with `requires` carries a `runWithout` half, described in the last column. A date case sends
`lastModified` of `stat` where it needs a date no `Last-Modified` lies after: a server caps
`Last-Modified` at its `Date` (section 10.3), so where the provider's clock runs ahead, the
`Last-Modified` of a first `GET` lies before the cap of the next answer.

**Serving**

| Case                         | Requires         | Cost   | Asserts                                                                                                                                                                                                                                                           |
| ---------------------------- | ---------------- | ------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `serve/whole`                |                  | `fast` | `GET` answers `200`, the bytes, the stored `Content-Type` and `Content-Length` equal to the size                                                                                                                                                                  |
| `serve/headers`              |                  | `fast` | `X-Content-Type-Options: nosniff`, `Cache-Control: private, no-cache`, `ETag` the quoted `etag` of `stat` and none where `stat` has none, `Last-Modified` the `lastModified` of `stat` at whole seconds                                                           |
| `serve/disposition`          |                  | `fast` | A key ending in `résumé 100%.pdf` answers `attachment; filename="r_sum_ 100_.pdf"; filename*=UTF-8''r%C3%A9sum%C3%A9%20100%25.pdf`                                                                                                                                |
| `serve/head`                 |                  | `fast` | `HEAD` answers `200` with the headers of the `GET`, `Content-Length` equal to the size among them, and no body; with `Range: bytes=0-1` it answers the same                                                                                                       |
| `serve/not-found`            |                  | `fast` | A missing key answers `404` with an empty body to `GET`, to `HEAD` and to `GET` with `If-Match: *`; the key `a//b` answers `404`                                                                                                                                  |
| `serve/method-not-allowed`   |                  | `fast` | `POST`, `PUT` and `DELETE` answer `405` with `Allow: GET, HEAD`; the object is unchanged                                                                                                                                                                          |
| `serve/range`                | `rangeReads`     | `fast` | `bytes=2-5`, `bytes=4-` and `bytes=2-999` on a 16-byte object answer `206` with the bytes, `Content-Range`, `Content-Length` and `Accept-Ranges: bytes`. Without: `200` and the whole object, no `Accept-Ranges`                                                  |
| `serve/suffix-range`         | `rangeReads`     | `fast` | `bytes=-3` answers `206` with the last three bytes and `Content-Range: bytes 13-15/16`. Without: `200` and the whole object                                                                                                                                       |
| `serve/unsatisfiable-range`  | `rangeReads`     | `fast` | `bytes=16-` on a 16-byte object answers `416` with `Content-Range: bytes */16`. Without: `200` and the whole object                                                                                                                                               |
| `serve/ignored-range`        |                  | `fast` | `bytes=0-1,3-4`, `items=0-1` and `bytes=x` each answer `200` and the whole object                                                                                                                                                                                 |
| `serve/if-none-match`        |                  | `fast` | The `ETag` of a first `GET`, also as `W/`, and `*` answer `304` without a body; another tag answers `200`. Where the first `GET` carried no `ETag`, `*` alone is sent                                                                                             |
| `serve/if-modified-since`    |                  | `fast` | `lastModified` of `stat` at whole seconds answers `304`, a second before the `Last-Modified` of a first `GET` answers `200`; beside an `If-None-Match` that fails to match it is ignored and the answer is `200`                                                  |
| `serve/if-match`             |                  | `fast` | The strong `ETag` of a first `GET` and `*` answer `200`; another tag and the `ETag` as `W/` answer `412`. Where the first `GET` carried no `ETag`, any tag answers `412` and `*` answers `200`                                                                    |
| `serve/if-unmodified-since`  |                  | `fast` | A second before the `Last-Modified` of a first `GET` answers `412`, `lastModified` of `stat` at whole seconds answers `200`; beside an `If-Match: *` it is ignored and the answer is `200`                                                                        |
| `serve/if-range`             | `rangeReads`     | `fast` | `Range: bytes=2-5` with the strong `ETag` of a first `GET` answers `206`; with another tag or with a date it answers `200` and the whole object. Without: `200` and the whole object for each                                                                     |
| `serve/content-language`     | `contentHeaders` | `fast` | A stored `contentLanguage` `de-AT` is answered as `Content-Language: de-AT` to `GET`, to `HEAD` and on a `304`. Without: an object written without them is answered without `Content-Language`                                                                    |
| `serve/stored-disposition`   | `contentHeaders` | `fast` | A stored `attachment; filename="stored.pdf"` is answered as stored; a stored `inline; filename="x.html"` is answered as `attachment` with the key's last segment. Without: an object written without them is answered as `attachment` with the key's last segment |
| `serve/stored-cache-control` | `contentHeaders` | `fast` | A stored `public, max-age=60` is answered as `Cache-Control: private, no-cache`, since the route passes no options. Without: `private, no-cache`                                                                                                                  |

**Redirecting**

| Case                          | Requires        | Cost   | Asserts                                                                                                                                                                                                                       |
| ----------------------------- | --------------- | ------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `redirect/found`              | `presignedUrls` | `fast` | `GET` with `redirect: "manual"` answers `302`, an absolute `Location`, `Cache-Control: private, no-store` and an empty body; `fetch` on `Location` answers `200` and the bytes. Without: `"presignGet" in storage` is `false` |
| `redirect/head`               | `presignedUrls` | `fast` | `HEAD` with `redirect: "manual"` answers `302` with an absolute `Location`. Without: as above                                                                                                                                 |
| `redirect/method-not-allowed` | `presignedUrls` | `fast` | `POST` answers `405` with `Allow: GET, HEAD`. Without: as above                                                                                                                                                               |

**Uploading**

| Case                          | Requires | Cost   | Asserts                                                                                                                                                                                                     |
| ----------------------------- | -------- | ------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `upload/stores`               |          | `fast` | `PUT` of 64 KiB with `Content-Type: text/plain` answers `201` with an empty body and the quoted `etag` of `stat` as `ETag`, none where `stat` has none; the object reads back byte for byte as `text/plain` |
| `upload/streamed-body`        |          | `fast` | `PUT` of a 512 KiB stream without a length answers `201`; the object reads back byte for byte                                                                                                               |
| `upload/content-type-default` |          | `fast` | `PUT` without `Content-Type` under a key without an extension stores `application/octet-stream`                                                                                                             |
| `upload/empty-body`           |          | `fast` | `PUT` without a body answers `201`; `stat` reports size 0                                                                                                                                                   |
| `upload/overwrites`           |          | `fast` | A second `PUT` under the same key answers `201` and replaces the bytes                                                                                                                                      |
| `upload/max-size`             |          | `fast` | 1048576 bytes answer `201`. Over a stored object, 1048577 bytes as bytes answer `413` or fail as a network error, as a stream without a length answer `413`, and the object reads back unchanged            |
| `upload/content-encoding`     |          | `fast` | `PUT` with `Content-Encoding: gzip` answers `415`; the key is absent                                                                                                                                        |
| `upload/method-not-allowed`   |          | `fast` | `POST` and `GET` answer `405` with `Allow: PUT`; the key is absent                                                                                                                                          |
| `upload/invalid-key`          |          | `fast` | `PUT` under the key `a/` answers `404`                                                                                                                                                                      |
| `upload/no-header-metadata`   |          | `fast` | `PUT` with `x-amz-meta-a: 1` and `x-ms-meta-a: 1` answers `201`; `stat` reports `userMetadata` `{}`                                                                                                         |

**Presigning**

| Case                           | Requires        | Cost   | Asserts                                                                                                                                                                                                                                                                                        |
| ------------------------------ | --------------- | ------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `presign/put`                  | `presignedUrls` | `fast` | `contentType` `text/plain` and `contentLength` 11 answer `200`, `application/json`, `Cache-Control: private, no-store` and `{ url, method: "PUT", headers }`; `fetch` with `PUT`, `headers` and 11 bytes answers `2xx`, and `stat` reports both. Without: `"presignPut" in storage` is `false` |
| `presign/method-not-allowed`   | `presignedUrls` | `fast` | `GET`, `HEAD`, `PUT` and `DELETE` answer `405` with `Allow: POST`; the key is absent. Without: as above                                                                                                                                                                                        |
| `presign/too-large`            | `presignedUrls` | `fast` | `contentLength` 1048577 answers `413`. Without: as above                                                                                                                                                                                                                                       |
| `presign/invalid-length`       | `presignedUrls` | `fast` | `contentLength` `-1`, `1.5` and `"11"` each answer `400`. Without: as above                                                                                                                                                                                                                    |
| `presign/invalid-content-type` | `presignedUrls` | `fast` | `contentType` `""` and `"a\nb"` each answer `400`. Without: as above                                                                                                                                                                                                                           |
| `presign/invalid-key`          | `presignedUrls` | `fast` | The key `a/` answers `404`. Without: as above                                                                                                                                                                                                                                                  |

## 15. Versions

- The eleven packages carry one version and are released together.
- Below 1.0, a patch release repairs code that disagrees with this document. Every other release
  is a minor, whether it adds a promise or withdraws one. A changeset for a change that takes
  something from a caller starts with `**Breaking:**`.
- What a caller may rely on is what this document states. A change only the compiler sees counts
  like a change in behavior, with two exceptions, each a minor release before and after 1.0:
  - A name added to `StorageErrorCode` or `capabilityNames`. A `switch` over either needs a default
    branch.
  - A member added to a concrete type an adapter's factory returns, such as `S3Storage`. A test
    double for code that stays portable is typed as `Storage`. Removing or narrowing a member stays
    breaking. `Storage`, `ConformanceTarget` and `HttpConformanceTarget` are not concrete types in
    this sense (ADR 0042).
- The defaults this document declares movable, the backoff numbers of sections 7.5, 8.5 and 9.5
  and the upload numbers of sections 7.6, 8.6 and 9.6, move in a minor release and never in a
  patch.
- A new conformance case is a minor release. A patch may repair a case and may not add one. A case
  changed to assert more of a target than it did is a withdrawal, since a target that passed it
  may fail it (ADR 0064). A new required member on `ConformanceTarget` is breaking; a new optional
  one is not. The same holds for the HTTP conformance suite, where a new value of the `answer` that
  `url` addresses counts as a new required member.
- A promise this document states for the first time takes nothing from a caller, so what a
  promised provider cannot hold is written into it without a withdrawal (ADR 0059). An option a
  storage refused as unknown with `InvalidOption`, which a release accepts or refuses as
  `Unsupported`, is no withdrawal either: the input was never valid (ADR 0060).
- Tightening a key rule is a minor release below 1.0 and a major above it. Loosening one is neither.
- A provider promised later does not narrow the parity core: what it cannot hold becomes a
  capability its adapter does not declare. Where a difference refuses that shape, as a batch size
  does, a published capability name narrowed to what the new provider holds, or the number of
  requests `get` costs, the change names its conflict with ADR 0017 and is a withdrawal like any
  other.
- Dropping a runtime or a Node line that reached end of life leads the changelog entry and is not
  a breaking change, before or after 1.0.
- An integration adds a framework major in a minor release once CI covers it, and its peer range
  widens to hold both. A major its framework no longer supports leaves the same way a Node line at
  end of life does: Next.js's at the end of its Maintenance LTS, NestJS's and Hono's when the next
  major is released. Dropping a major its framework still supports, and raising a peer range's
  floor, are withdrawals (ADR 0047, ADR 0050).
- Nothing is deprecated before it is removed below 1.0. There is no pre-release channel.
- 1.0 promises that a breaking change costs a major release and that a minor marks with
  `@deprecated` what a later major removes. It promises no support window and no fixes for an older
  line. `SECURITY.md` states how to report a vulnerability and that a fix lands in the current line
  alone.
- 1.0 waits until section 18 lists no promise a real endpoint has not answered, and for the author
  having used stowage in a project of their own. A promise leaves section 18 when a scheduled run
  observes it or when it is withdrawn.

## 16. Documentation

Twelve READMEs point into this document. A README states no promise of its own; a line in a README
that disagrees with this document is corrected without a changeset.

- The repository root README shows the package family and opens with two blocks: the same four
  calls, `put`, `get`, `list` and `delete`, against `fsStorage` and against `s3Storage`, differing
  only in how the storage is constructed. Reference flow 1 follows as the second example, a `put`
  of `request.body`, and one sentence after it links `acceptUpload` of `@stowage/http` and the
  three integrations for a route with a size limit, without a code block. The package table lists
  all eleven packages (ADR 0055).
- `@stowage/core`, `@stowage/adapter-memory`, `@stowage/adapter-fs`, `@stowage/adapter-s3`,
  `@stowage/adapter-azure-blob` and `@stowage/adapter-gcs` carry the sections install, example,
  runtimes, limits and notes, in that order, then the link into this document at the tag of their
  release. An empty section says that it is empty.
  - Runtimes: what the package declares, the Bun and Deno versions CI last ran green, the measured
    bundle size.
  - Limits: the capabilities the package does not declare, each beside a link into section 4.9;
    for `adapter-fs` the 255-byte segment, NFD on APFS and the derived content type of section 6;
    for `adapter-s3` the R2 normalization to NFC and the rows of section 7.2; for
    `adapter-azure-blob` the missing `userMetadataTokenKeys`, the three refused kinds of writable
    key and the batch of 256 of section 8.1, and the rows of section 8.2; for `adapter-gcs`
    `presignedUrls` only with a `signer`, the two refused kinds of writable key and the batch of 100
    of section 9.1, the requests of `get`, up to four where a writer replaces the object, the
    metadata values that XML readers see garbled,
    and a cursor handed to a listing of another prefix yielding an empty page, and the rows of
    section 9.2.
  - Notes, what a caller writes themselves: for `adapter-s3` how a connection URL is split into
    `bucket`, `region`, `endpoint` and `credentials`; for every adapter `blob.stream()` for a caller
    holding a `Blob`, and a byte counter written as a `TransformStream` in front of `put`.
  - For `adapter-azure-blob` the example is written with an access token, and the notes lead with
    it: the few lines that wrap an `@azure/identity` credential's `getToken` in a resolver, then the
    account key with Microsoft's advice against it beside it, how a connection string is split into
    `account`, `endpoint` and `credentials`, the CORS rule flow 2 needs, and that
    `InvalidBlockList` on a commit usually means that another writer won.
  - For `adapter-gcs` the example is written with an access token, and the notes lead with it: a
    resolver of three lines around a `google-auth-library` `GoogleAuth` client with the scope
    `https://www.googleapis.com/auth/devstorage.read_write`, which passes `forceRefresh` on to a
    forced refresh, and that the library loads on `workerd` only under `nodejs_compat`, where the
    token comes from a resolver of the caller's own. Then the two forms of `signer` and the scope
    `signBlob` needs, and the CORS rule flow 2 needs. No key exchange is shown.
- `@stowage/http`, `@stowage/nestjs`, `@stowage/hono` and `@stowage/nextjs` carry the same
  sections in the same order (ADR 0055). No order is fixed among their notes.
  - Runtimes of an integration: the peer range, the floor and the newest version CI ran at the
    release, the package's cells of section 2's second table with a link there, NestJS on Express
    and on Fastify apart, the Bun and Deno versions CI last ran green where the package runs there,
    and the bundle size measured without the framework. Runtimes of `@stowage/http`: its cells and
    that the Node bridge covers Node, Bun and Deno and not `workerd`.
  - `@stowage/http`: the example is a `fetch` handler answering `GET` and `HEAD` with `serveObject`
    and `PUT` with `acceptUpload` and its `maxSize`, the key named by the caller. Limits: the `403`
    S3 and GCS answer to a `HEAD` followed through `redirectToObject` (section 10.4). Notes: Express
    through the Node bridge; Fastify through `reply.hijack()` and an application-wide content type
    parser behind `removeAllContentTypeParsers()`, with `maxSize` taking over from `bodyLimit`,
    which that parser switches off; Bun's
    `maxRequestBodySize` of 128 MiB; and that the body reaches the layer unread.
  - `@stowage/nestjs`: the example is `StorageModule.forRoot({ provide, storage })` and a
    controller that injects with `@Inject(token)` and answers through `@Req()`, `@Res()`,
    `webRequestOf` and `sendResponse`. Limits are empty. Notes: on Fastify
    `removeAllContentTypeParsers()`, since Fastify's own parsers read `application/json` and
    `text/plain` whatever `bodyParser` says, then
    `addContentTypeParser("*", (_req, _payload, done) => done(null))`, with `maxSize` taking over
    from `bodyLimit`; `NestFactory.create(AppModule, { bodyParser: false })` for uploads sent as
    JSON; `forRootAsync` with `inject`; a test replacing the storage with
    `overrideProvider(token).useValue(…)`.
  - `@stowage/hono`: the example is `withStorage(name, storage)` typed through chaining and a route
    serving through `serveObject`. Limits are empty. Notes: the same typing through an `Env` the
    application states; the factory built from `c.env` on `workerd`; validators reading the body
    on upload routes; `bodyLimit()`, `etag()` and `compress()` on stowage's routes; Bun's 128 MiB
    body limit; a test building the app from a function that takes its storages.
  - `@stowage/nextjs`: the example is the application's storage module, starting with
    `import "server-only"` and exporting `lazyStorage(…)`, and a route handler under a catch-all
    `[...key]` answering `GET` and `PUT`. Limits: a Proxy matching an upload route cuts a chunked
    body at `proxyClientMaxBodySize` unnoticed, so the application leaves upload routes out of its
    `matcher` or raises the limit above `maxSize`. Notes: the catch-all segments arriving decoded,
    so `a%2Fb` cannot be told apart from two segments; presigning through a route handler rather
    than a server action; `await connection()` before presigning in a Server Component; no
    `force-static`, `revalidate` or `'use cache'` around a `get`; a resolver built in the factory
    existing once per module graph; a test mocking the application's storage module.
- `@stowage/conformance` has a shape of its own: how to write a `ConformanceTarget`, how the
  declaration on the storage is filled, how the cases reach Vitest, `bun:test` and `Deno.test`
  through `describeConformance`, what `runAll` is for on `workerd`, and `adapter-memory` as the
  implementation to read. A section "Test a server" follows the one on `workerd`: how to write an
  `HttpConformanceTarget` and run the HTTP cases, with `@stowage/hono` as the implementation to
  read.
- Every `ts` block in a README and in this document compiles against the built declarations in
  this repository's tests, each document with the compiler options its reader's application uses:
  the README of `@stowage/nestjs` with `experimentalDecorators` and without
  `erasableSyntaxOnly`, against `@types/node` and `@types/express` (ADR 0055). Links are not
  checked.
- TSDoc is written where a meaning was decided: the ten error codes, the six capability names,
  `retry`, `multipart`, `expiresIn`, `contentLength` on `presignPut`, the three content headers on
  `PutOptions`, on `ObjectStat`, on `presignPut` and on the options of `acceptUpload` and
  `presignUpload`, `contentEncoding`, `storedCacheControl`, the two forms of
  `AzureBlobCredentials`, the two forms of `GcsSigner`, `headers` on `PresignedPut`, `maxSize`,
  `expiresIn` on `redirectToObject` and `presignUpload`, `disposition`, `cacheControl`,
  `storageErrorOf`, `objectStatOf`, `global` on `StorageModule`, the factories of `withStorage`
  and `lazyStorage`, and every field whose bounds this document fixes.
- There is no documentation site, no `examples/` workspace, no `CODE_OF_CONDUCT.md` and no issue
  template. The reference flows exist as the prose of section 3 and the cases of section 14.6.

## 17. Non-goals

v0.6 does not have, and does not promise a path to:

- Bucket and container management: creating, listing or deleting them.
- A connection URL, a connection string or any other configuration string, and a key file or a
  credential configuration file, in any package.
- Credential providers beyond static credentials, an access token the caller's resolver obtained,
  and `fromEnv`: no IMDS, no web identity, no managed identity, no metadata server, no workload
  identity federation, no exchange of a service-account key for a token, no chain, no bridge to
  `@aws-sdk/credential-providers`, `@azure/identity` or `google-auth-library`.
- A SAS token as a credential, and HMAC keys on GCS.
- Anonymous or unsigned requests.
- Presigned `POST` policies, presigned multipart uploads, presigned block uploads and presigned
  resumable uploads.
- Writing `Content-Encoding` through `put`, `Expires`, and a generic map of headers on `put`
  (ADR 0058).
- Changing the content headers of an object that exists, through an option of `copy` or `move` or
  an operation of its own (ADR 0058).
- Binding the absence of a content header into a presigned upload (ADR 0063).
- Reading a header value of 16 KiB or more that another tool stored, which Node's `fetch` fails to
  read (ADR 0059).
- Conditional operations, versioning, object lock, tagging, storage classes, ACLs, server-managed
  encryption, customer-supplied encryption keys, requester pays and `x-amz-checksum-*` headers; on
  Azure Blob, append and page blobs, access tiers, snapshots, soft delete, leases, immutability
  policies and blob index tags; on GCS, object holds, retention policies, customer-managed and
  customer-supplied encryption keys and Autoclass.
- Accounts and buckets with hierarchical namespace, sovereign clouds, other universes and
  dual-region turbo replication as promised targets.
- Chunked signing, a per-runtime hasher, and any option to skip payload signing on a request the
  adapter sends.
- Progress reporting, an upload id, and resuming an upload or a download.
- Cleaning up multipart uploads a dead process left behind, the uncommitted blocks a failed
  upload leaves on Azure Blob, and a resumable session on GCS whose cancel did not arrive.
- A fallback for `copy` above the single-request limit of S3 and Azure Blob: neither
  `UploadPartCopy` nor blocks copied by range, and no `Copy Blob` that may stay pending.
- A cache of user delegation keys.
- A migration helper that moves a prefix between two storages with concurrency and resume.
- Clock skew correction against the provider's `Date` header.
- A timeout per request attempt.
- A `raw` escape hatch below the concrete adapter type.
- A package of its own for any framework beyond NestJS, Hono and Next.js; Express and Fastify as
  promised frameworks by name; and framework majors older than the one current at v0.5's release,
  such as NestJS 11 and Next.js 15.
- A listing endpoint in `@stowage/http`, and parsing `multipart/form-data` (ADR 0054).
- Consumer providers such as Dropbox or WebDAV, a documentation site, a registry of conforming
  adapters, and monetization of any kind.
- Windows as a platform for `adapter-fs`, and hosts as promised targets.

## 18. Settled by the first run

The following have not yet been observed against a real endpoint. A promise a scheduled run
disproves is withdrawn in a minor release, and 1.0 waits until the first list below is empty
(section 15). The first run against AWS S3 and R2, the first run against the Azure account and the
first run against the GCS bucket, each on Node and `workerd`, disproved none of the points they
settled; those are stated in the sections they belong to. The one promise no run could provoke,
that R2 answers `ExpiredRequest` for an expired credential, a probe of its own disproved, and it is
withdrawn (section 7.2, ADR 0045). Each point left here names why no run has answered it.

Promises:

- `adapter-gcs`: the JSON resource returns `cacheControl`, `contentDisposition` and
  `contentLanguage` as sent, a tab and a run of spaces included, after `uploadType=multipart`, a
  resumable upload, `rewriteTo` without a body and `moveTo`. The measurements behind ADR 0059 ran
  against the XML API, whose documentation differs from the JSON API's on `Cache-Control`. The
  scheduled run's `put/content-headers`, `put/content-headers-multipart`, `copy/content-headers`
  and `move/content-headers` against the bucket answer it.
- `adapter-azure-blob`: a user delegation SAS naming the `x-ms-blob-*` headers in `srh` admits an
  upload carrying the signed values and refuses one whose value differs or that lacks one,
  `x-ms-blob-content-type` among them (section 8.9). No signature of a real key over them has been
  measured, since `Get User Delegation Key` needs an Entra token; the scheduled run on `main`, whose
  token can, answers it through `presign/put-content-headers`,
  `presign/put-rejects-content-headers` and the repository test of section 14.4 (ADR 0063).

Recorded only, since this document already states what follows from any answer:

- `adapter-azure-blob`: whether Azure collapses runs of spaces in a value `srh` binds, as SigV4
  and GOOG4 do. Section 8.9 states the binding exact up to runs of spaces either way.

- `adapter-s3`: how the multipart answers and `<Deleted><Key>` spell a key holding `U+FFFE`, how
  R2 encodes a space under `encoding-type=url`, and whether R2's continuation token is ASCII. No
  test of the scheduled run asks them yet.

What a run may add or loosen, in a minor release and without a withdrawal:

- `adapter-s3`: whether a `DeleteObjects` body holding `&#xFFFE;` or `&#65534;` deletes the object
  on AWS S3 and R2. If one spelling does on both, these keys go back into the batch without a
  change to this document. No test of the scheduled run sends either body yet.
- `adapter-azure-blob`: whether a key holding a character from `U+0080` to `U+009F` needs
  refusing. A refusal shown needless is loosened. The first run sent `U+0085` alone, which the
  account stored and listed as written; the scheduled run now sends each of the 32.
