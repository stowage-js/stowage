# What `@azure/storage-blob` and `@azure/identity` cost across Node, Bun, Deno and `workerd`

Research for issue [#107](https://github.com/stowage-js/stowage/issues/107), a child of the v0.2
spec map [#104](https://github.com/stowage-js/stowage/issues/104). ADR 0003 ruled out
`@aws-sdk/client-s3` for its form rather than its size: errors, retries and streams would pass
through its middleware, and the parity core would end up promising whatever the SDK does. This
note collects the same facts for Microsoft's Azure SDK, so #109 can make the same judgement for
Azure Blob. It extends the prior-art survey of #6 (branch `research/prior-art-api-surfaces`), which
did not cover Azure.

All measurements and sources are from **2026-09-24**, on macOS (Darwin 27.0.0, arm64), against
Azurite 3.37.0 on `127.0.0.1`. No request reached Azure.

## How to read the evidence markers

| Marker         | Meaning                                                                                    |
| -------------- | ------------------------------------------------------------------------------------------ |
| **Measured**   | Observed by running code on this machine. The scripts and commands are below.              |
| **Documented** | Stated by a primary source (package source, README, changelog, issue), with a URL or path. |
| **Unverified** | Not confirmed against a primary source. Never rely on these without testing first.         |

## Answer

**Measured: the SDK runs on all four runtimes only through its Node build.** Node 24.21.0,
Node 26.8.2, Bun 1.4.2 and Deno 2.9.7 each resolve the `import` build without a bundler, and
`put`, `get`, `list` and `delete` all pass against Azurite with a Shared Key. The same Node build,
bundled for `node`, passes in `workerd` 2026-09-21 at compatibility date 2026-09-01, where
`nodejs_compat` is now on by default. The build that `workerd` bundlers normally pick, through the
`workerd`, `worker` and `browser` conditions, throws `ReferenceError: document is not defined` at
module evaluation, before any request is sent. Separately from that crash, the browser build cannot
sign with Shared Key and has no `uploadStream` at all.

**Documented: Microsoft promises LTS Node and four desktop browsers, nothing else.** Bun, Deno and
Cloudflare Workers are not named in the README or `SUPPORT.md`, and Node 26 does not count until it
becomes LTS on 2026-10-28.

**Measured: the form is the same problem ADR 0003 found with the AWS SDK.** The service's error code
comes back as `RestError.code` when the response has a body and as `details.errorCode` when it has
none (a `HEAD`). The built-in retry policy sends four attempts with no jitter and a 4 s base delay,
retries `500` and `503` only, cannot be replaced, and resends a Node `Readable` body the first
attempt already consumed. Uploads take a Node `Readable` and reject a web `ReadableStream` on every
runtime.

**Measured: size is large but not the deciding cost.** A put, get, list and delete client bundles to
580 KiB minified and 148 KiB gzipped. That is about eleven times the 13.4 kB `adapter-s3` records
with `@stowage/core` included. `@azure/storage-blob` alone installs 29 packages and 26.2 MB, and
adding `@azure/identity` brings it to 58 packages and 49.0 MB.

**Measured and documented: `@azure/identity` runs wherever the Node build runs, and nowhere else
with a server credential.** On Node, Bun, Deno and `workerd` (2026-09-01) it loads and sends a token
request. Its `workerd` export condition is a byte-identical copy of the Node build and needs Node
APIs. Its browser build offers `InteractiveBrowserCredential`, `ClientSecretCredential` (exported
"for development purposes") and `UsernamePasswordCredential`. Every other credential throws
`… is not supported in the browser`.

## Versions

| What                                | Version                                                                 | How established                                                                         |
| ----------------------------------- | ----------------------------------------------------------------------- | --------------------------------------------------------------------------------------- |
| `@azure/storage-blob`               | 12.33.0 (`latest`), published 2026-06-24                                | **Documented**, `npm view` on <https://registry.npmjs.org/@azure/storage-blob>          |
| `@azure/identity`                   | 4.13.3 (`latest`), published 2026-09-14                                 | **Documented**, `npm view`                                                              |
| `@azure/storage-common`             | 12.5.0                                                                  | **Measured**, installed tree                                                            |
| `@azure/core-rest-pipeline`         | 1.25.0                                                                  | **Measured**, installed tree                                                            |
| `@typespec/ts-http-runtime`         | 0.3.9 (`latest`)                                                        | **Measured**, installed tree; `npm view`                                                |
| `@azure/msal-node` / `msal-browser` | 6.0.1 / 5.23.0                                                          | **Measured**, installed tree (7.0.0 of `msal-node` exists, outside identity's `^6.0.0`) |
| Azurite                             | 3.37.0                                                                  | **Measured**, npm install into scratch                                                  |
| `workerd`                           | 1.20260921.1 (`workerd 2026-09-21`), the version `harness/workerd` pins | **Measured**, `workerd --version`                                                       |
| esbuild                             | 0.28.2                                                                  | **Measured**                                                                            |
| Node                                | 24.21.0, 26.8.2                                                         | **Measured**, absolute paths under `~/.nvm/versions/node`                               |
| Bun / Deno                          | 1.4.2 / 2.9.7                                                           | **Measured**, `--version`                                                               |

Both Azure packages declare `engines.node >=22.0.0`, ship ESM, CommonJS, browser and
react-native builds, and identity adds a `workerd` condition. **Documented**, the packages'
`package.json` `exports`.

## Method

Everything was installed into scratch directories under `$TMPDIR`, never into the repository:
`blob/` with `@azure/storage-blob@12.33.0`, `identity/` with `@azure/identity@4.13.3`, `both/` with
both, and `tools/` with `esbuild` and `azurite`. Two long-running processes served every run:

```sh
node tools/node_modules/azurite/dist/src/blob/main.js \
  --blobHost 127.0.0.1 --blobPort 10000 --skipApiVersionCheck --inMemoryPersistence
node tools/proxy.mjs   # counting proxy on 127.0.0.1:10001, see below
```

`proxy.mjs` forwards to Azurite and counts requests, so every step of a probe reports how many HTTP
requests it cost, on every runtime, without touching the SDK's own `httpClient` option. A path that
starts with `/fault<status>/` is answered by the proxy itself with that status, an
`x-ms-error-code: ServerBusy` header and a Blob-style XML error body. `/faultreset/` destroys the
socket. That is how the retry policy was measured.

The probe (`both/probe/ops.mjs`) runs these steps in order and reports each one's result or error,
together with the number of requests it sent:

1. `createIfNotExists` on a container
2. `upload(string, length)`, `uploadData(Uint8Array)`, `upload(webReadableStream, length)`,
   `uploadStream(webReadableStream)`, and `uploadStream(nodeReadable)` where the runtime has one
3. `download()` of the string blob, read back as whatever body the build returns
4. `listBlobsFlat({ prefix })`
5. `delete()`
6. `getProperties`, `download` and `delete` on an absent key, then `exists`

Each error is reduced to `name`, `constructor.name`, the first line of `message`, `code`,
`statusCode`, the keys of `details`, `details.errorCode`, the `x-ms-error-code` response header and
the parsed body code.

Two entry points drive it. `node-entry.mjs` imports `@azure/storage-blob` unbundled, letting the
runtime pick the export condition, and signs with Azurite's published development key through
`StorageSharedKeyCredential`:

```sh
node   both/probe/node-entry.mjs         # 24.21.0 and 26.8.2, by absolute path
bun    both/probe/node-entry.mjs
deno run -A both/probe/node-entry.mjs    # resolves from the npm-installed node_modules
```

For `workerd`, `worker-sas.mjs` (account SAS, `AnonymousCredential`) and `worker-key.mjs` (Shared
Key) were bundled two ways with esbuild, standing in for wrangler:

```sh
# The conditions wrangler resolves for a Worker
esbuild worker-sas.mjs --bundle --format=esm --platform=browser \
  --conditions=workerd,worker,browser --outfile=dist/worker-sas-browser.js
# The Node build. CommonJS dependencies call require("net") and require("tty"), which
# esbuild's ESM output cannot satisfy, so a banner supplies a require from node:module.
esbuild worker-key.mjs --bundle --format=esm --platform=node --outfile=dist/worker-key-node.js \
  '--banner:js=import { createRequire as __cr } from "node:module"; const require = __cr("/");'
```

`cell.mjs <bundle> <flags> <date>` writes a one-worker `workerd` config with that bundle,
compatibility date and flags, and an outbound network that allows `local`. It then starts the
`workerd` binary the repository's harness pins, fetches the worker once and prints the report, or
the startup error when the worker does not load.

Bundle sizes came from `sizes.mjs`, which runs esbuild with `--minify` in both resolution modes over
four entries: put, get, list and delete with Shared Key, with a SAS URL, with
`ClientSecretCredential`, and with `DefaultAzureCredential`. It reports the minified size, the
`gzip -9` size and the bytes per package from esbuild's metafile. Install sizes are apparent bytes
summed over every file below `node_modules`.

The retry measurements (`retry.mjs`) use `retryDelayInMs: 10, maxRetryDelayInMs: 50`, so each
fault takes milliseconds rather than seconds. That changes the delays and leaves the count and the
set of retried conditions alone. One run with default options timed the real delays:

```js
// retry.mjs, abridged: one client per fault, counting requests through the proxy.
const service = new BlobServiceClient(`http://127.0.0.1:10001/${account}`, undefined, {
  retryOptions,
});
const blob = service.getContainerClient("c").getBlockBlobClient("k");
const before = await proxyCount();
try {
  await act(blob);
} catch (e) {
  outcome = describeError(e);
}
const requests = (await proxyCount()) - before;
```

`retry-stream.mjs` repeats the one ambiguous case, a Node `Readable` body under a `503`, against a
raw `node:net` server that answers `503` as soon as it has read the headers. It records the bytes of
each request it receives.

## Results

### Runtimes, unbundled (Node build)

**Measured.** Identical on Node 24.21.0, Node 26.8.2, Bun 1.4.2 and Deno 2.9.7:

| Step                                    | Result                                              | Requests                           |
| --------------------------------------- | --------------------------------------------------- | ---------------------------------- |
| `createIfNotExists`                     | ok                                                  | 1                                  |
| `upload(string, 11)`                    | ok                                                  | 1                                  |
| `uploadData(Uint8Array)`                | ok                                                  | 1                                  |
| `upload(web ReadableStream, 10)`        | `RestError: Unrecognized body type`                 | 0                                  |
| `uploadStream(web ReadableStream)`      | `TypeError: this.readable.on is not a function`     | 0                                  |
| `uploadStream(node Readable, 11 bytes)` | ok                                                  | 2 (`Put Block` + `Put Block List`) |
| `download()`                            | ok, body as `readableStreamBody`, a Node `Readable` | 1                                  |
| `listBlobsFlat({ prefix })`             | ok                                                  | 1                                  |
| `delete()`                              | ok                                                  | 1                                  |

The HTTP client under all four is `node:http`/`node:https`: `createDefaultHttpClient` in
`@typespec/ts-http-runtime/dist/esm/defaultHttpClient.js` returns `createNodeHttpClient()`. The
`fetch` client exists only in the browser build. **Documented**, package source. On Bun and Deno it
therefore runs on their `node:http` compatibility layers, not on their `fetch`.

### `workerd`

**Measured**, `workerd 2026-09-21`:

| Bundle                                   | Compatibility date        | Flags              | Result                                                                                        |
| ---------------------------------------- | ------------------------- | ------------------ | --------------------------------------------------------------------------------------------- |
| `workerd,worker,browser` conditions, SAS | 2026-09-01                | none               | worker fails to load: `ReferenceError: document is not defined`                               |
| same                                     | 2026-09-01                | `nodejs_compat`    | same failure; `workerd` also warns that `nodejs_compat` "became the default as of 2026-08-04" |
| Node build, Shared Key                   | 2026-09-01                | none               | **every step as on Node**, same requests, same error shapes                                   |
| same                                     | 2026-09-01                | `no_nodejs_compat` | fails to load: `No such module "node:os"`                                                     |
| same                                     | 2026-08-01                | none               | fails to load: `No such module "node:module"`                                                 |
| same                                     | 2026-08-01                | `nodejs_compat`    | every step as on Node                                                                         |
| same                                     | 2026-01-01 and 2025-10-01 | `nodejs_compat`    | fails to load: `No such module "node:tty"`, reached from `debug` through `https-proxy-agent`  |
| same                                     | 2025-09-01 and 2025-06-01 | `nodejs_compat`    | fails to load: `No such module "node:os"`                                                     |

The crash in the first two rows is `@azure/core-xml`'s browser build, which runs this at module
evaluation (`dist/browser/xml-browser.mjs`, line 4):

```js
if (!document || !DOMParser || !Node || !XMLSerializer) {
  throw new Error(`This library depends on the following DOM objects: ...`);
}
```

`workerd` has none of the four, and `!document` throws before the `Error` does. The README lists
the same four globals as polyfills a Web Worker needs. **Documented**,
`@azure/storage-blob/README.md`, "Web Workers".

What the browser build lacks, even with a DOM polyfill (**Documented**, package source; **Measured**
at build time):

- `StorageSharedKeyCredential` is not exported from `dist/browser/index.js`: esbuild fails with
  `No matching export … for import "StorageSharedKeyCredential"`. The class inside
  `@azure/storage-common`'s browser build throws `StorageSharedKeyCredential is not supported in
the browser`, and its signing policy passes the request through unsigned. Microsoft declined
  Shared Key for "browser(-like) environments" in 2023: "we'd rather not support account key in
  browser because the account key would be available for long time"
  (<https://github.com/Azure/azure-sdk-for-js/issues/24736>). A maintainer suggested a separate
  export condition for server-side non-Node runtimes in the same thread. Nothing came of it for
  storage.
- `uploadStream` exists, but `BufferScheduler` in the browser build throws `BufferScheduler is not
supported in non-Node.js environments.` (`storage-common/dist/browser/BufferScheduler-browser.mjs`).
- A download is buffered whole: the fetch client turns a streamed response into
  `blobBody = new Response(body).blob()` unless `enableBrowserStreams` is set
  (`ts-http-runtime/dist/browser/fetchHttpClient.js`), and nothing in the storage packages sets it.

The side finding matters beyond Azure: `workerd` now enables `nodejs_compat` by default from
compatibility date 2026-08-04 (**Measured**, both rows above). `no_nodejs_compat` alone does not
restore the earlier state: `nodejs_compat_v2`, also on by default, keeps `process`, `Buffer` and
about 14 `node:` modules such as `node:buffer`, `node:crypto` and `node:stream` reachable. Only
`no_nodejs_compat` together with `no_nodejs_compat_v2` matches 2026-08-03 with no flags
(**Measured**, see [#118](https://github.com/stowage-js/stowage/issues/118)).
`harness/workerd/workerd.capnp` pins 2026-09-01 with no flags, and its comment says the cell shows
that `adapter-memory` and `adapter-s3` "reach no Node API". At that date the cell no longer shows
that.

### Install size and dependency tree

**Measured**, apparent bytes under `node_modules`:

| Install               | Packages | Files | Size     |
| --------------------- | -------- | ----- | -------- |
| `@azure/storage-blob` | 29       | 4 300 | 26.23 MB |
| `@azure/identity`     | 43       | 5 768 | 28.31 MB |
| both                  | 58       | 8 131 | 48.95 MB |

The largest packages are `@azure/storage-blob` itself (15.34 MB, which matches the registry's
`unpackedSize` of 15 343 732), `@azure/msal-browser` (13.55 MB, installed on Node too),
`@azure/msal-common` (2.96 MB), `@azure/msal-node` (2.50 MB) and `@typespec/ts-http-runtime`
(2.36 MB).

The packages outside `@azure/` (**Measured**, `npm ls --all`):

- under storage-blob: `fast-xml-parser` and six packages of its own, `http-proxy-agent`,
  `https-proxy-agent`, `agent-base`, `debug`, `ms`, `events`, `tslib`
- under identity: `jsonwebtoken` and eleven packages below it (`jws`, `jwa`, seven `lodash.*`,
  `semver`, `safe-buffer`, …), and `open` with seven packages that locate and launch a desktop
  browser (`default-browser`, `run-applescript`, `is-wsl`, …)

### Bundle size

**Measured**, esbuild 0.28.2, `--minify`, ESM:

| Client doing put, get, list, delete                | Resolution               | Minified                                                                                 | gzip -9                              |
| -------------------------------------------------- | ------------------------ | ---------------------------------------------------------------------------------------- | ------------------------------------ |
| Shared Key                                         | `node`                   | 580 KiB                                                                                  | 148 KiB                              |
| SAS URL                                            | `node`                   | 580 KiB                                                                                  | 148 KiB                              |
| SAS URL                                            | `workerd,worker,browser` | 464 KiB                                                                                  | 114 KiB (does not load in `workerd`) |
| `ClientSecretCredential`                           | `node`                   | 871 KiB                                                                                  | 229 KiB                              |
| `ClientSecretCredential`                           | `browser` only           | 475 KiB                                                                                  | 116 KiB                              |
| `DefaultAzureCredential`                           | `node`                   | 913 KiB                                                                                  | 240 KiB                              |
| `ClientSecretCredential`, `DefaultAzureCredential` | `workerd,worker,browser` | build fails: `Could not resolve "crypto"` (identity's `workerd` build is the Node build) |                                      |

In the Shared Key bundle, `@azure/storage-blob` accounts for 300 KiB, `@azure/storage-common` for
113 KiB, `@azure/core-client` for 27 KiB, `fast-xml-parser` for 27 KiB and
`@typespec/ts-http-runtime` for 25 KiB. `@azure/msal-common` (110 KiB) and `@azure/msal-node`
(85 KiB) come in with identity. For scale, `packages/adapter-s3/README.md` records 13.4 kB minified
and gzipped for `adapter-s3` with `@stowage/core`.

### Errors

**Measured**, identical on all five cells that load:

| Call on an absent key      | `name`                    | `statusCode` | `code`         | `message`                            | `details.errorCode` | `x-ms-error-code` |
| -------------------------- | ------------------------- | ------------ | -------------- | ------------------------------------ | ------------------- | ----------------- |
| `getProperties()` (`HEAD`) | `RestError`               | 404          | **undefined**  | **empty**                            | `BlobNotFound`      | `BlobNotFound`    |
| `download()` (`GET`)       | `RestError`               | 404          | `BlobNotFound` | `The specified blob does not exist.` | `BlobNotFound`      | `BlobNotFound`    |
| `delete()` (`DELETE`)      | `RestError`               | 404          | `BlobNotFound` | same                                 | `BlobNotFound`      | `BlobNotFound`    |
| `exists()`                 | returns `false`, no error |              |                |                                      |                     |                   |
| socket reset               | `RestError`               | none         | `ECONNRESET`   | `socket hang up`                     |                     |                   |

Why (**Documented**, package source): `RestError` is `@typespec/ts-http-runtime`'s class,
re-exported by `@azure/core-rest-pipeline`. `core-client`'s `deserializationPolicy` sets
`error.code` from the parsed body (`error.code = internalError.code`) and puts the operation's
response headers, including `x-ms-error-code` as `errorCode`, into `details`. A `HEAD` has no body, so
its code is absent and its message is the empty body text. The service's string therefore reaches
the caller unchanged, but in one of two places depending on the method. A caller matching on
`e.code` misses every `stat` failure. On a transport failure the Node client copies the system error
code (`ECONNRESET`), and the fetch client uses `cause.code` or `REQUEST_SEND_ERROR`
(`fetchHttpClient.js`, `getError`).

Esbuild renames the class to `_RestError` in the `workerd` bundle, while `name` stays `RestError`.
The SDK's own guard is `isRestError`, not `instanceof`.

### Retry policy

`@azure/storage-blob` removes the core pipeline's retry phase and inserts its own
(`dist/esm/Pipeline.js`):

```js
corePipeline.removePolicy({ phase: "Retry" });
corePipeline.removePolicy({ name: decompressResponsePolicyName });
corePipeline.addPolicy(storageRetryPolicy(restOptions.retryOptions), { phase: "Retry" });
```

The policy is `storageRetryPolicy` in `@azure/storage-common/dist/esm/policies/StorageRetryPolicyV2.js`.
Its defaults are `maxTries: 4`, `retryDelayInMs: 4000`, `maxRetryDelayInMs: 120000` and
`EXPONENTIAL`, with the delay `min((2^(attempt-1) - 1) * 4000, 120000)` and no jitter. That is 0 s,
4 s and 12 s before attempts two to four. It retries a response status of `500` or `503`, a `404`
from the secondary host, a select set of copy-source error codes, and an error whose `name`,
`message` or `code` contains one of `ETIMEDOUT`, `ESOCKETTIMEDOUT`, `ECONNREFUSED`, `ECONNRESET`,
`ENOENT`, `ENOTFOUND`, `TIMEOUT`, `EPIPE` or `REQUEST_SEND_ERROR`. It does not read `Retry-After`.
**Documented**, package source.

**Measured**, Node 24.21.0, requests counted at the proxy:

| Fault                                              | Requests        | What reached the caller                                      |
| -------------------------------------------------- | --------------- | ------------------------------------------------------------ |
| `500`                                              | 4               | `RestError`, 500, `ServerBusy`                               |
| `503`                                              | 4               | `RestError`, 503, `ServerBusy`                               |
| `502`, `504`, `408`, `429`                         | 1 each          | `RestError` with that status                                 |
| socket reset                                       | 4               | `RestError`, `ECONNRESET`                                    |
| `503`, `maxTries: 1`                               | 1               | `RestError`, 503                                             |
| `503`, `maxTries: 10`                              | 10              | `RestError`, 503 (no ceiling on `maxTries`)                  |
| `503`, default options                             | 4 in **16.0 s** | `RestError`, 503                                             |
| `503`, default options, `AbortSignal` after 300 ms | 2               | `AbortError`, at 303 ms: the signal interrupts the wait      |
| `503` on `upload(string)`                          | 4               | `RestError`, 503                                             |
| `503` on `upload(() => nodeReadable, 3)`           | 4               | `RestError`, 503: a body factory is replayed                 |
| `503` on `uploadStream(nodeReadable)`              | 4               | `RestError`, 503: each block is a factory over a held buffer |
| `503` on `upload(nodeReadable, 3)`                 | **2**           | `RestError`, **400**, no `code`, empty message               |

The last row is a resend of a consumed body. Against the raw server of `retry-stream.mjs`, the
second request on the connection carried `Content-Length: 3` and no body bytes, and the upload was
still pending when the script stopped it after 5 s. Through the proxy it came back as a `400` in
14 ms instead. Either way the caller does not learn that the service said `503`.

Can it be switched off or replaced (**Documented**, package source):

- Off: `retryOptions: { maxTries: 1 }`, measured above. There is no `false`.
- Replaced: no. `StoragePipelineOptions` carries `retryOptions` and nothing that takes a policy.
  A custom `Pipeline` may carry v1 request policy factories, but `processDownlevelPipeline` drops
  any it recognises as a `StorageRetryPolicyFactory` and wraps the rest above the retry phase. The
  storage policy is then added regardless, so a caller's own retry always sits above the SDK's,
  multiplying with it unless `maxTries` is 1. A caller-supplied `httpClient` sits below it.
- Below the policy nothing else retries a status. The core retry phase is removed, and a `429`
  costs exactly one request, measured above.

Two more loops sit outside that policy, both **Documented** from source and not measured:

- On the Node build, `download()` wraps the body in `RetriableReadableStream`, which re-issues the
  `GET` with `Range` and `If-Match: <etag>` when the body breaks, up to `maxRetryRequests`,
  default 5 (`DEFAULT_MAX_DOWNLOAD_RETRY_REQUESTS`). Each of those requests goes through the four
  attempts again.
- A `TokenCredential` goes through `bearerTokenAuthenticationPolicy` with
  `authorizeRequestOnTenantChallenge` wired in, and identity's own token requests run on a pipeline
  of their own with their own `retryOptions`.

For contrast, ADR 0013 gives three attempts, full jitter capped at 5 s, `408`, `429` and every `5xx`,
and never repeats a stream body.

### Uploads

**Documented**, `BlockBlobClient.uploadStream` in `dist/esm/Clients.js` and `BufferScheduler` in
`@azure/storage-common`:

- The signature is `uploadStream(stream, bufferSize = 8 MiB, maxConcurrency = 5, options)`, and
  its JSDoc says "ONLY AVAILABLE IN NODE.JS RUNTIME" and "@param stream - Node.js Readable stream".
  The scheduler reads with `.on("data")` and `.pause()`.
- It holds up to `maxConcurrency` pooled buffers of `bufferSize` each, so 40 MiB by default, and
  uploads up to `ceil(maxConcurrency * 3 / 4)` = 4 at once.
- The block size is `bufferSize`, fixed by the caller and never scaled with the stream. With
  50 000 blocks allowed, the default reaches about 390 GiB.
- It always sends `Put Block` and then `Put Block List`, even for 11 bytes (**Measured**, 2 requests).
- A web `ReadableStream` fails on every runtime (**Measured**): `uploadStream` with `TypeError:
this.readable.on is not a function`, and `upload(stream, length)` with `RestError: Unrecognized
body type`. The Node HTTP client accepts a Node stream, a factory returning one, a `Blob` or bytes.
- `uploadData` sends a single `Put Blob` up to `maxSingleShotSize`, default 256 MiB, and blocks
  above that.

### `@azure/identity`

**Measured**: on Node 24.21.0, Node 26.8.2, Bun 1.4.2, Deno 2.9.7 and `workerd` (Node build,
2026-09-01), `new DefaultAzureCredential()` constructs. `ClientSecretCredential.getToken` against a
closed local HTTPS authority fails with `CredentialUnavailableError: endpoints_resolution_error`,
which means `msal-node` got as far as sending its discovery request.

**Documented** (package source and changelog):

- The `workerd` condition was added in 4.9.0 "for Cloudflare environment"
  (<https://github.com/Azure/azure-sdk-for-js/pull/32422>), after a request to make
  `ClientCertificateCredential` work there
  (<https://github.com/Azure/azure-sdk-for-js/issues/31467>). `dist/workerd` is byte-identical to
  `dist/esm` (`diff -rq`, measured): it imports `@azure/msal-node`, `node:crypto` and
  `node:fs/promises`, and so needs `nodejs_compat`.
- Under wrangler's conditions the pipeline packages beneath identity still resolve to their browser
  builds, because `@typespec/ts-http-runtime` 0.3.9 has no `workerd` condition. That produced
  `proxyPolicy is not supported in browser environment` on Workers
  (<https://github.com/Azure/azure-sdk-for-js/issues/37345>), closed on 2026-09-16 by a merged pull
  request adding the condition (<https://github.com/Azure/azure-sdk-for-js/pull/39085>). As of
  0.3.9, the current `latest`, it has not been released.
- In the browser build, `InteractiveBrowserCredential` works through `msal-browser`.
  `ClientSecretCredential` and `UsernamePasswordCredential` are real implementations, the former
  commented "exported on browser bundles for development purposes". The rest throw on
  `getToken`: `DefaultAzureCredential`, `EnvironmentCredential`, `ManagedIdentityCredential`,
  `WorkloadIdentityCredential`, `ClientCertificateCredential`, `ClientAssertionCredential`,
  `OnBehalfOfCredential`, `AuthorizationCodeCredential`, `DeviceCodeCredential`,
  `AzurePipelinesCredential`, and the CLI, PowerShell and VS Code credentials, each with
  `… is not supported in the browser`.

### Maintenance signals

**Documented**, npm `time` and the repository:

- `@azure/storage-blob` stable releases since 2025: 12.27.0 (2025-03-19), 12.28.0 (07-24), 12.29.0
  (08-22), 12.29.1 (10-17), 12.30.0 (2026-01-16), 12.31.0 (02-10), 12.32.0 (06-05), 12.33.0
  (06-24), with betas between them. Roughly one every two months, each tracking a service version.
  The unreleased 12.35.0-beta.1 migrates the package to TypeSpec code generation
  (<https://github.com/Azure/azure-sdk-for-js/blob/main/sdk/storage/storage-blob/CHANGELOG.md>).
- `@azure/identity` has released about monthly (4.8.0 in 2025-03 to 4.13.3 on 2026-09-14).
  `@azure/msal-node` went from 5.6.0 to 6.0.0 to 7.0.0 between 2026-08-18 and 2026-09-23, which is
  two majors in five weeks.
- Support policy: "LTS versions of Node.js" and the latest Safari, Chrome, Edge and Firefox
  (<https://github.com/Azure/azure-sdk-for-js/blob/main/SUPPORT.md>, storage-blob README). The README's
  "Compatibility" section still says "validated against LTS Node.js versions (>=8.16.0)", while
  `engines` says `>=22.0.0`.
- Non-Node runtimes in the issue tracker: Bun was broken by `isNode` detection until 12.23.0
  (<https://github.com/Azure/azure-sdk-for-js/issues/28949>, closed 2024-06). Deno raised
  `Cannot read properties of undefined (reading 'bun')`
  (<https://github.com/Azure/azure-sdk-for-js/issues/30108>, closed 2024-06). The Workers issues
  are the two above. A semantic search for open issues on web streams, Workers, Deno or Bun in
  storage found none besides two unrelated download issues.
- Web-standard plans: "[core] Fetch http client for both browsers and NodeJS"
  (<https://github.com/Azure/azure-sdk-for-js/issues/38519>) is open since 2026-05-12, labelled
  `future-nodejs`, with no comments or pull request. "Converge to WebStreams and drop NodeJS
  streams" (<https://github.com/Azure/azure-sdk-for-js/issues/27464>) was closed by the stale bot on
  2025-10-20 without being resolved. No stated plan was found beyond these.

## Prior art wrapping Azure Blob

| Project                                 | Version read       | Built on                                                   | Authenticates with                                                                                                                 | What it implements                                                                                                                                                                                                                                                                                                                                                                                                             |
| --------------------------------------- | ------------------ | ---------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| flydrive                                | 2.1.0              | n/a                                                        | n/a                                                                                                                                | No Azure driver. The `exports` map lists `drivers/fs`, `drivers/gcs` and `drivers/s3` only. **Documented**, `npm view flydrive exports`                                                                                                                                                                                                                                                                                        |
| `@tweedegolf/sab-adapter-azure-blob`    | 3.0.2 (2026-05-16) | `@azure/storage-blob ^12.31.0`, `@azure/identity ^4.13.1`  | account key, SAS token, connection string, else `DefaultAzureCredential`, parsed from `azure://account:key@container` or an object | containers, list, read as a Node `Readable`, write via `uploadStream(stream, 64000, 20)`, delete, size, URLs. Every error becomes `getErrorMessage(e)`, a string. CommonJS (`require("url")`). **Documented**, npm tarball `dist/AdapterAzureBlob.js`                                                                                                                                                                          |
| `unstorage` `azure-storage-blob` driver | 1.17.5             | `@azure/storage-blob`, `@azure/identity` as optional peers | account key, SAS URL, SAS key, connection string, else `DefaultAzureCredential`                                                    | `hasItem` via `exists`, `getItem` buffers the whole blob through `.on("data")`, `setItem` via `upload`, `removeItem` via `deleteIfExists`, `getKeys` and `clear` paged by 1000, `getMeta` from `getProperties`. `getItem` swallows every error to `null`. It detects the browser with `typeof window !== "undefined"`, which is false on `workerd`, Bun and Deno. **Documented**, npm tarball `drivers/azure-storage-blob.mjs` |
| small `fetch`-based client              | none found         |                                                            |                                                                                                                                    | Four `npm search` queries ("azure blob fetch", "azure blob cloudflare", "azure storage shared key signature", "keywords:azure-blob fetch") surfaced no maintained standalone client. Only multi-provider wrappers came up, which were not inspected                                                                                                                                                                            |

tweedegolf's block size of 64 000 bytes caps an upload at 50 000 × 64 000 bytes, about 3.2 GB. It
also buffers 20 of them.

## What this constrains

1. **#109, wire protocol or SDK.** The SDK can reach all four runtimes only as its Node build, and on
   `workerd` only with `nodejs_compat` and a bundle that resolves the `node` condition rather than
   the ones wrangler uses. It would also fall under ADR 0003's objection point by point: the provider
   code sits in two places, the retry policy cannot be replaced and disagrees with ADR 0013 on
   count, jitter, statuses and stream bodies, and uploads take a Node `Readable` where the core
   takes a web `ReadableStream`. The same argument that ruled out `@aws-sdk/client-s3` applies.
2. **#109, if the SDK were used anyway.** It would have to be pinned to its Node build on every
   runtime, `retryOptions.maxTries` set to 1 so ADR 0013's loop runs alone, error codes read from
   both `code` and `details.errorCode`, and every web stream bridged to a Node `Readable` before
   `uploadStream`. That bridge would add a 40 MiB default buffer.
3. **#111, credential scope.** Shared Key and SAS need nothing Node-specific on the wire, but the SDK
   signs Shared Key only in its Node build. Entra tokens through `@azure/identity` work on the four
   runtimes only through `msal-node` and Node APIs, at 229–240 KiB gzipped. In the browser build the
   server-side credential types are stubs that throw. Whatever #111 decides for Entra, the only
   library route needs `nodejs_compat` on `workerd`.
4. **#115, write the v0.2 spec.** The spec cannot inherit Microsoft's support statement for any cell
   of the matrix except Node 24, and Node 26 only from 2026-10-28.
5. **Fog patch: runtime matrix for the Azure adapter.** `workerd` has enabled `nodejs_compat` by
   default since compatibility date 2026-08-04, measured. The v0.1 `workerd` harness pins
   2026-09-01 with no flags, so it no longer proves that `adapter-s3` reaches no Node API. An Azure
   adapter's `workerd` cell needs `no_nodejs_compat` and `no_nodejs_compat_v2` to prove it.

## Explicitly not verified

- **No real Azure endpoint.** Everything ran against Azurite 3.37.0. Error bodies and headers on
  Azure itself, `Retry-After` on Azure's `503`, and whether Azure and Azurite ever disagree between
  body `<Code>` and `x-ms-error-code` were not observed. The injected faults always carried the same
  code in both.
- **No Entra token was acquired.** `DefaultAzureCredential.getToken` was deliberately not run: its
  chain runs the local Azure CLI and calls the instance metadata endpoint, both outside this task.
  Managed identity, workload identity and certificate credentials were not exercised on any runtime.
- **Wrangler itself was not run.** Its resolution was emulated with esbuild conditions, and the Node
  build needed a `require` banner that wrangler's own `nodejs_compat` handling may do differently.
  The deployed Workers platform, as opposed to local `workerd`, was not tested.
- **The compatibility-date floor for the Node build on `workerd`** lies somewhere between 2026-01-02
  and 2026-08-01. Only the dates in the table were run.
- **Memory was not measured.** Neither `uploadStream`'s buffers nor the Node build's download stream
  on `workerd` were profiled. The 40 MiB figure comes from the source.
- **Why the consumed-stream resend came back as `400` through the proxy** was not traced. The raw
  capture shows what was sent, and not how Node's HTTP server answered it.
- **Deno ran from an npm-installed `node_modules`**, not through `npm:` specifiers. Only one Bun and one
  Deno version were run.
- **The retry loops outside the policy**, the download resume and the bearer-token challenge, were
  read in source and not provoked.
- **The multi-provider wrappers from the npm search** were not inspected.

`registry.npmjs.org`, `raw.githubusercontent.com` and the GitHub API responded. The sandbox refused
the one run that reached the host's Azure CLI profile and `169.254.169.254`, as intended, and that
run was replaced by the construction-only probe above.
