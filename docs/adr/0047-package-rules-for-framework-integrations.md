# Integrations take their framework as a peer, promise its current major and release with the rest

v0.5 adds `@stowage/nestjs`, `@stowage/hono` and `@stowage/nextjs`, each wiring a storage into its
framework and serving it through `@stowage/http` (ADR 0046). A package that sits inside a framework
has to import that framework's functions and types, which ADR 0003's "no published package has a
runtime dependency" and its "declares no peer dependency" did not foresee.

An integration therefore declares its framework as a peer dependency: the framework packages it
imports, and at least the framework's main package (`@nestjs/common`, `hono`, `next`) even where it
imports nothing from it. A regular dependency was ruled out because it can put a second copy of the
framework into the application's graph; `hono-storage` broke on exactly that, with `Property
'#private' in type 'Context' refers to a different member` against Hono 4
(`research/hono-integration`, commit `b9feab7`). A peer only where something is imported would have
left `@stowage/nextjs` without one if it exports nothing but `(Request, ctx) => Response`, and the
peer range is the one place npm checks the framework versions a package promises. An optional peer
says the framework may be absent, which it may not. Beyond the peer an integration depends on
`@stowage/*` alone, which rules out `server-only` in `@stowage/nextjs`: Next.js aliases it, and
anywhere else it is a third-party package (`research/nextjs-integration`, commit `be1540b`).

Each integration promises the framework's current major at its release: NestJS 12, Hono 4 and
Next.js 16. NestJS 11 would load stowage through Node 24's `require(esm)`, Next.js 15 is in
Maintenance LTS until about 2026-10-21, and each of them would have been one more set of cells under
ADR 0002 in a release that is meant to add three frameworks. A later major is added in a minor
release once CI covers it, and the peer range widens to hold both.

A framework major that its framework no longer supports leaves the way a Node line at end of life
does, outside the contract, for the reason ADR 0017 gives: making it a major would let another
project's calendar decide stowage's version number. Next.js publishes a support policy, so its
major ends with its Maintenance LTS. NestJS and Hono publish none (`research/nestjs-integration`,
commit `15b6565`), so their major ends when the next one is released. Treating every drop like a
runtime's, outside the contract whatever the framework says, would have let stowage strand a caller
on a major its framework still patches; treating every drop as a withdrawal would have made each
framework major a breaking release of stowage after 1.0.

The integrations join the `fixed` group of ADR 0008, which grows to eleven packages. Versioning
them on their own would have answered the cadence argument ADR 0046 raised and left open, at the
price of the compatibility matrix ADR 0008 removed: which `@stowage/nextjs` runs against which
`@stowage/http`, and what 1.0 means for a family whose members are at different numbers. A new
framework major costs a minor release of all eleven, the same release of unchanged packages ADR 0008
already pays for, and with the rule above a dropped major is almost never a breaking one.

## Consequences

- Spec section 1 reads: "No package has a runtime dependency outside `@stowage/*`. An integration
  declares its framework as a peer dependency and nothing else." This replaces ADR 0003's statement
  that no package declares a peer dependency for the integrations alone; the rest of ADR 0003
  stands. `@stowage/http` and `@stowage/core` are regular `dependencies` of an integration, written
  `workspace:^` as the adapters write `@stowage/core`.
- The peer ranges at v0.5 are `@nestjs/common` `^12`, `hono` `^4` and `next` `^16`. Spec section 1
  names each integration's promised majors; section 15 gains the rule for adding and dropping a
  framework major beside the one for runtimes and Node lines. Dropping a major its framework still
  supports is a withdrawal, and its changeset starts with `**Breaking:**`.
- The names are the framework's own, in lower case: `@stowage/nestjs`, `@stowage/hono`,
  `@stowage/nextjs`. No prefix like `adapter-`, which `CONTEXT.md` keeps for adapters, and not
  `@stowage/next`, which reads as the next stowage.
- The `fixed` group in `.changeset/config.json` and spec section 15 list eleven packages:
  the seven of v0.4, `@stowage/http` and the three integrations. Each new package needs a `0.0.0`
  placeholder on npm and trusted publishing from `release.yml` before its first release.
- stowage's sources contain no decorator syntax. `@stowage/nestjs` calls NestJS's decorator
  functions directly, such as `Module({ … })(StorageModule)`, and injects through `useFactory` and
  `inject`, so the shared `tsconfig` of ADR 0008, `erasableSyntaxOnly` included, holds for every
  package and the sources stay runnable without a build. The application writes `@Inject(token)`
  in its own code.
- Which runtimes each integration promises and which framework versions CI covers is decided under
  "When a framework integration counts as supported" (#308).
- No promise a released package makes is narrowed, so ADR 0017 is extended, not contradicted.
- ADR 0050 narrows the peer ranges above to start at the versions CI ran at v0.5's release. Spec
  section 2 names them: `@nestjs/common` `^12.1.2`, `hono` `^4.13.12`, `next` `^16.3.8`.
