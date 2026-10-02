# A server is supported where a published HTTP suite covers it on a real socket in CI

ADR 0002 makes a cell of the runtime matrix supported only where the conformance suite covers it in
CI, with no weaker level. v0.5 adds things the suite cannot reach: `@stowage/http` and its Node
bridge (ADR 0046) and the integrations for NestJS, Hono and Next.js (ADR 0047). They are servers,
not storages. ADR 0002 holds for them unchanged: a server's cell is supported where a published
suite covers it in CI. That suite is the HTTP conformance suite, a second list of cases in
`@stowage/conformance`.

Its cases assert what a client can observe over HTTP, the way the conformance suite asserts what
the core API lets a caller observe (spec 14.4): the statuses, headers and bodies ADR 0048 and ADR
0049 promise for serving, redirecting, accepting an upload and presigning one. They need `fetch` and
a `Storage` and nothing else, so `@stowage/conformance` gains no dependency on `@stowage/http` or on
any framework. The alternative was tests in this repository alone. The HTTP layer is public and
promised so that SvelteKit, Express or a framework nobody has named yet can reach stowage, and that
promise would rest on nothing a third party can run. A package of its own,
`@stowage/http-conformance`, would have made twelve packages for a list of cases that fits beside
the first.

A target names the server it runs against:

```ts
export interface HttpConformanceTarget {
  readonly name: string;
  createStorage(): Storage | Promise<Storage>;
  url(answer: "serve" | "redirect" | "upload" | "presign", key: string): URL;
  cleanup?(keyPrefix: string): Promise<void>;
}

export const httpConformanceCases: readonly HttpConformanceCase[];

export function describeHttpConformance(
  target: HttpConformanceTarget,
  framework: ConformanceFramework,
): void;
```

`createStorage()` returns a storage that addresses the objects the server serves, through which a
case seeds and reads them. `url` names the route that gives one answer for one key, and the case
sends the request itself, its method, headers, `HEAD` and abort included. The alternative was a
`request(answer, key, init)` on the target, which would have the target rebuild every request and
could change a header the case meant to send. The suite fixes the options each route is configured
with, such as a `maxSize` of 1 MiB, since a case has to know the limit it tests. An
`HttpConformanceCase` carries `name`, `requires` and `cost` as a conformance case does, and what
the storage from `createStorage()` declares decides whether `run` or `runWithout` runs. There is
no `runAll` beside `describeHttpConformance`: the cases are client code, and on `workerd` only the
server runs inside the runtime.

Two promises no client can observe stay with this repository's tests, in a list like spec 10.4's:
that a client disconnecting cancels the stream `get` returned and reaches the provider (flow 4),
run on every runtime of a cell, and that memory stays flat through an upload and a download, run on
Node as the adapters' test is. The research on `research/hono-integration` (commit `b9feab7`)
measured `workerd` no longer pulling a JavaScript-sourced stream after a disconnect without calling
`cancel`; the test against the stream of `get` settles it, and a cell it fails on carries no "yes".
The layer's status table and its retry of a ranged `ProviderError` as a whole `get` are tested in
this repository against a storage that answers so, since no endpoint in CI produces a content-coded
object on demand.

## Consequences

- An integration promises the runtimes its framework promises, within stowage's four. Hono names
  all four and runs on them (`research/hono-integration`, commit `b9feab7`). NestJS names Node
  alone, although Bun and Deno behaved alike in every measured case (`research/nestjs-integration`,
  commit `15b6565`). Next.js promises Node; Next.js 16 deprecated the `middleware.ts` convention
  and renamed it to `proxy.ts` (`research/nextjs-integration`, commit `be1540b`). Promising NestJS
  on Bun and Deno would have
  promised more than its framework does, and ADR 0002's matrix promises less than a runtime can do,
  never more. Express or Fastify on Bun or Deno still reaches stowage through the Node bridge.
- Spec section 2 gains a second table against the four runtimes, with rows for `@stowage/http` on
  all four, the Node bridge on Node, Bun and Deno, NestJS on Express and NestJS on Fastify on Node,
  Hono on all four and Next.js on Node. NestJS's two platforms are two rows because they differ in
  exactly what a test has to prove: Express needs the bridge, Fastify answers `HEAD` on a route
  returning a `Response` with `500` and streams an upload only through a content type parser.
  Below the table the spec names, per framework, the lowest and the newest version CI runs.
- Every cell runs a real server over a socket: `@stowage/http` alone on `Bun.serve`, `Deno.serve`
  and `workerd`'s `fetch`, and on Node through the bridge; the bridge on `node:http`'s
  `createServer` on Node, Bun and Deno; Hono on `@hono/node-server`, `Bun.serve`, `Deno.serve` and
  `workerd`; NestJS through `app.listen` on each platform; Next.js through `next build` and
  `next start`. A framework's test utilities — `app.request`, `supertest`,
  `Test.createTestingModule` — prove nothing here, because `HEAD`, disconnects and streaming are
  what the frameworks deviate in, and those utilities skip the server.
- On Node, Bun and Deno the server and the cases share one process under that runtime's harness.
  For `workerd` and `next start` the Node harness starts the server as a child process.
- Behind every server is `adapter-s3` against SeaweedFS, which every runtime job already starts. A
  server in another process cannot share `adapter-memory` with the cases, and `adapter-memory`
  declares no `presignedUrls`, so it would leave redirecting and presigning to `runWithout`. No
  other emulator and no real endpoint runs behind a server: an integration adds no provider
  behavior, and the conformance suite already covers each adapter.
- Every HTTP case costs `fast` and runs on every pull request.
- On `workerd` the HTTP suite runs under `no_nodejs_compat` and `no_nodejs_compat_v2` and a second
  time under the date's default flags, as the conformance suite does (ADR 0002).
- Each integration's peer range starts at the version CI ran against at v0.5's release and keeps
  that floor afterwards, which narrows ADR 0047's `^12`, `^4` and `^16` before any of them is
  released. CI runs the floor and the newest version of each framework on every Node line, Node 24
  and 26 alike, so both ends of the range are covered and no later release has to raise the floor,
  which ADR 0017 would make a withdrawal. Renovate keeps the floor and updates the newest version.
  Testing only the newest version under `^12` would have promised 12.0.0 without ever running it;
  `^4` would have reached back to Hono 4.0.0 of February 2024.
- The new CI jobs join the required checks on `main`.
- `CONTEXT.md` gains HTTP conformance suite and HTTP conformance target; Runtime matrix covers
  servers beside flows.
- No promise a released package makes is narrowed, so ADR 0017 is extended, not contradicted.
- Under "Write the v0.5 spec" (#309) the spec names below the second table the floor of each
  framework, which is part of the peer range, and that CI also runs the newest release of the
  major. It does not name the newest version, which Renovate moves; each integration's README names
  the one CI ran at its release, as ADR 0055 has it.
- The spec fixes the routes a target serves: `serveObject` without options, `redirectToObject`
  with `expiresIn: 60`, `acceptUpload` with `maxSize: 1048576`, and a presign route that reads
  `{ contentType, contentLength }` from a `POST` body and hands both unchanged to `presignUpload`
  with the same `expiresIn` and `maxSize`. That body is the target's route, not a protocol of the
  layer. The `serve`, `redirect` and `upload` routes hand each method the cases send to the layer,
  so the layer answers `405`. The `presign` route itself answers non-`POST` methods with `405`
  and `Allow: POST`.
- A new value of the `answer` that `url` addresses counts as a new required member of
  `HttpConformanceTarget`, and is breaking. `HttpConformanceTarget` is no concrete type under ADR
  0042's member rule.
- The `400` for a body contradicting its `Content-Length` is a repository test over a raw socket,
  since `fetch` cannot send such a header.
