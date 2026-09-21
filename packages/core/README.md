# @stowage/core

The types every stowage adapter implements, `StorageError`, and the utilities an adapter calls. It does nothing without an adapter.

The package is not released yet and exports no API. What it will hold is written in
[`docs/spec.md`](https://github.com/stowage-js/stowage/blob/main/docs/spec.md#4-the-core-api-stowagecore), which is the contract: a caller may rely on what that document
states and on nothing else a package happens to export.

## Runtimes

Node 24 and later, Bun, Deno and `workerd` at the compatibility date `2026-09-01`. The Bun and Deno versions CI last ran green are named here once CI has run them.

## Documentation

- [The specification](https://github.com/stowage-js/stowage/blob/main/docs/spec.md)
- [The terms it uses](https://github.com/stowage-js/stowage/blob/main/CONTEXT.md)
- [The decisions behind it](https://github.com/stowage-js/stowage/tree/main/docs/adr)

## License

MIT
