# Contributing

## Set up

Node 24 or later and the pnpm version `packageManager` in `package.json` names. Docker runs the
emulators, and Bun and Deno are needed only for their own runs, in the versions `.bun-version` and
`.dvmrc` pin.

```sh
pnpm install
pnpm build
```

Build before anything else: the typecheck, the lint rules and the tests of every package but
`@stowage/core` read the other packages' built declarations, not their sources.

## Check a change

```sh
pnpm typecheck
pnpm lint
pnpm format:check
eval "$(./harness/start-all.sh)"
pnpm test
./harness/stop-all.sh
```

`pnpm test` runs the Node column of the [runtime matrix](docs/spec.md#2-runtime-matrix). The
suites of `adapter-s3`, `adapter-azure-blob` and `adapter-gcs` run against an emulator each, which
`start-all.sh` starts and whose environment it prints. A run without them fails rather than
passing with those suites skipped ([ADR 0012](docs/adr/0012-conformance-endpoint.md)).

`pnpm test:bun`, `pnpm test:deno` and `pnpm test:workerd` run the other columns. The README of each
endpoint under `harness/` says what it stands in for and how it differs from the provider.

## Change a promise

A caller may rely on what [the specification](docs/spec.md) states and on nothing else. A change to what it promises starts there, with an ADR in [`docs/adr`](docs/adr) for a
decision that was weighed, and uses the terms of [`CONTEXT.md`](CONTEXT.md).

A pull request a caller would notice carries a changeset, written with `pnpm changeset`. One that
takes something from a caller starts it with `**Breaking:**`, as
[spec 15](docs/spec.md#15-versions) asks. A change to the documentation alone carries none.

The title of a pull request follows [Conventional Commits](https://www.conventionalcommits.org),
since a squash merge makes it the commit on `main`.

## Write an adapter outside this repository

[`@stowage/conformance`](packages/conformance) holds the cases every adapter passes, and its README
walks through running them against yours.

## Report a vulnerability

Through [`SECURITY.md`](SECURITY.md), never in a public issue.
