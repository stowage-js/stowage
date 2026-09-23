# @stowage/adapter-s3

A storage in one bucket of AWS S3 or Cloudflare R2, spoken to over the S3 wire protocol rather than through an SDK.

The package is not released yet and exports no API. What it will hold is written in
[`docs/spec.md`](https://github.com/stowage-js/stowage/blob/main/docs/spec.md#7-stowageadapter-s3), which is the contract: a caller may rely on what that document
states and on nothing else a package happens to export.

## Runtimes

Node 24 and later, Bun, Deno and `workerd` at the compatibility date `2026-09-01`. CI last ran green on Bun 1.4.2 and Deno 2.9.6.

## Documentation

- [The specification](https://github.com/stowage-js/stowage/blob/main/docs/spec.md)
- [The terms it uses](https://github.com/stowage-js/stowage/blob/main/CONTEXT.md)
- [The decisions behind it](https://github.com/stowage-js/stowage/tree/main/docs/adr)

## License

MIT
