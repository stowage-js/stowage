# Credentials resolve per request, and their form belongs to the adapter

`@stowage/adapter-s3` takes one option for authentication, `credentials:
Resolvable<S3Credentials>`. `S3Credentials` is `accessKeyId`, `secretAccessKey` and an optional
`sessionToken`, and it is the adapter's own type: no two providers authenticate alike, and the
parity core needs none of it. What `@stowage/core` contributes is the pattern around it, `type
ResolverOptions = { forceRefresh: boolean }` and `type Resolvable<T> = T | ((options?:
ResolverOptions) => T | Promise<T>)` — a value, or a function that yields one. A static object
covers the common case and a function covers the rest, which is all that survives of the
`CredentialProvider` interface the concept proposed. Caching, refresh and chaining are what such
a function does, not what a type has to prescribe.

The adapter resolves before every request it signs and does not cache credentials between calls.
A resolved credential can still expire before or during a request. That is why `S3Credentials`
carries no expiry field: detecting expiry and refreshing remain the responsibility of the function
the caller wrote. If the provider reports `Expired`, the adapter retries once and calls that
function with `{ forceRefresh: true }` for the second attempt. A multipart upload signs each part
with a freshly resolved credential rather than with the one the first part used, so a rotation
halfway through reaches the second half.

What v0.1 ships as resolvers is static credentials and `fromEnv`. The other two the concept
named are absent: no reference flow runs on EC2 or EKS, IMDSv2 is a token handshake that cannot
be exercised without the matching cloud, `AssumeRoleWithWebIdentity` needs a file read that
Workers cannot perform, and both are AWS-specific in a package that promises R2 on equal terms.
Each is around twenty lines of caller code against the same option. `@stowage/credentials-aws`
is the named place for them once writing those lines twice becomes the common case.

`fromEnv` is the resolver itself rather than a factory that returns one, so a rotated
`AWS_SESSION_TOKEN` reaches the next request. It reads through `process.env`, which is the only
route in Node and Bun, the Node compatibility layer in Deno, and on Workers the bindings and
secrets rather than a machine environment. Two guards make it one function on all four: a
`typeof process` check for a Worker without `nodejs_compat`, and `try`/`catch` around each read,
because Deno throws `NotCapable` without `--allow-env` instead of answering `undefined`. It
reads the three names one at a time and never enumerates, since `Object.keys(process.env)`
requires the unscoped permission in Deno.

## Consequences

- The core interface stays closed as ADR-0004 states, and `Resolvable<T>` is a generic type in
  `@stowage/core` beside it. The closure covers the interface, not the package export: no core
  signature mentions `Resolvable`, so an application holding `Storage` still cannot reach a
  provider option.
- `credentials` is required. v0.1 sends no unsigned request, a public bucket is read with
  `fetch`, and an explicit anonymous option remains available later. An optional credential
  would turn a misspelled environment variable into a silent downgrade to unsigned requests,
  which a public bucket answers normally until someone writes.
- The resolver receives an optional `{ forceRefresh: boolean }` argument. A caching resolver
  whose cache is stale would otherwise answer the same expired credential to every retry.
  Static credentials and `fromEnv` ignore it.
- `Expired` is retried once, with `forceRefresh` in front of the second attempt and no backoff.
  It is the entry in the retry table that a delay does not help, and the error semantics left
  that table open.
- Before signing, the adapter checks that both required fields are non-empty strings and throws
  `InvalidCredentials` naming the empty one. An empty `accessKeyId` produces a well-formed
  signature that S3 rejects anyway, so this is the same error code one round trip earlier.
  `fromEnv` throws it too, naming the three variables it looked for.
- A presigned URL expires with the credential that signed it. The requested duration is an upper
  bound rather than a promise, and the TSDoc on `presign` says so; with a `sessionToken` in play
  that bound is the token's lifetime, whatever the caller asked for.
- Both conformance factories construct from outside the adapter, as the conformance suite
  requires. A storage with a wrong secret is a static object; an expired credential cannot be
  invented, because S3 does not answer `ExpiredToken` for a token it has never issued. ADR 0012
  therefore has the scheduled run request an STS token of the shortest duration AWS grants and
  run the `Expired` case once it has expired. Against R2 the case reports itself skipped, so
  `Expired` is a code v0.1 has observed against S3 alone.
