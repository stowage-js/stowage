# MIT license for the published packages

`LICENSE` has been MIT since the first commit, and this decision keeps it there. Apache 2.0 was
the alternative: permissive as well, but with an explicit patent grant that some companies
prefer, paid for with a `NOTICE` file in every published package and a license text an order
longer. That grant passes on patents the licensor holds, and this project implements documented
wire protocols and holds none, so it would pass on nothing. Every comparable package — flydrive,
`@tweedegolf/storage-abstraction`, `unstorage`, `aws4fetch`, `@bradenmacdonald/s3-lite-client` —
is MIT; of the prior art surveyed, only the official `@aws-sdk/client-s3` is Apache 2.0.

## Consequences

- Every published package ships a copy of `LICENSE` beside its `package.json`, in addition to
  the `"license": "MIT"` field. The field is metadata, not the license text, and a supply-chain
  review reads the file inside `node_modules`.
- Contributions require neither a CLA nor a DCO sign-off. `CONTRIBUTING.md` states that
  contributions are licensed under the project license. A CLA buys the option to relicense
  later, and monetization is a non-goal.
- Code ported from another project keeps its origin and original license in the file header, and
  `LICENSE` gains an attribution appendix. `@bradenmacdonald/s3-lite-client` is the model here:
  MIT throughout, with an Apache 2.0 notice for the parts taken from the MinIO JavaScript
  client.
