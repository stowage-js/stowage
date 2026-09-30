# The GCS adapter takes an access token and acquires none

`@stowage/adapter-gcs` takes one option for authentication, `credentials:
Resolvable<GcsCredentials>`, and follows ADR 0007 where its reasons carry over: the option is
required, the credential is resolved before every request the adapter sends and cached nowhere,
and no configuration string carries it. `GcsCredentials` is `{ accessToken: string }`, an OAuth 2.0
bearer token that the caller's resolver obtained. It is an object rather than a bare string so that
another form can join it as a union later, which ADR 0017 makes a minor release.

The access token is the one form, because it is the one that reaches the JSON API ADR 0031 chose
without the adapter acquiring anything. HMAC keys authenticate XML API requests alone; the JSON API
refuses them. A service-account key reaches the JSON API two ways, and neither is promised.
Exchanging a JWT it signed at `oauth2.googleapis.com` is token acquisition, which the map rules out
of v0.3. Sending such a JWT as the bearer itself is a scheme Google's own storage clients do not
use in the public universe and no Cloud Storage page documents. Both need a key that Google calls
discouraged and that organizations created since 2024-05-03 cannot create by default. A caller who
holds a key writes the exchange as a resolver, around twenty lines of `fetch` and Web Crypto.

The key has a second use that this decision leaves open: signing URLs locally. ADR 0032 declares
`presignedUrls` where the configuration names a way to sign — a key of its own, or a service account
for `signBlob` under a token — and that signer is a separate axis from the credential that
authenticates requests. A `signBlob` signer needs a token with the `iam` or `cloud-platform` scope,
wider than a storage token needs, and possibly a resolver of its own. It is decided with presigned
URLs, together with whether HMAC signs URLs.

GCS has no answer that means only that a token expired. Measured on 2026-09-28 against the
measurement bucket with a made-up token, every path answers `401` with `WWW-Authenticate: Bearer
realm="https://accounts.google.com/", error=invalid_token`: the JSON API with reason `authError`
and message "Invalid Credentials", a media download with the same words as `text/html`, and a
`HEAD` with no body. A request without `Authorization` answers `401` with reason `required` and no
`error` in the header. RFC 6750 gives `invalid_token` to an expired, revoked and malformed token
alike, and Google's status page lists expiry among the meanings of `authError`. The adapter
therefore reads the header, the one signal alike on all three paths, and repeats once after it, as
ADR 0021 does on Azure after `401 InvalidAuthenticationInfo`. Reading the body would have needed
two parsers for the same refusal and left `HEAD` without one.

## Consequences

- The resolved credential is checked before the first request, and each violation is
  `InvalidCredentials` naming the field: no `accessToken`, an empty one, or a field besides it. The
  token is opaque and is not parsed as a JWT.
- A `401` whose `WWW-Authenticate` carries `error=invalid_token` is repeated once, with the resolver
  called with `{ forceRefresh: true }` in front of the second attempt, on the budget ADR 0013 keeps
  for the `Expired` repeat. A second such `401` is `InvalidCredentials` with `attempts: 2`, and its
  message says the token expired or is not accepted. Any other `401` is `InvalidCredentials` and not
  repeated.
- `403` is `AccessDenied`, including `insufficientPermissions` for a token whose scope is too
  narrow for the operation: the principal is authenticated and may not do this.
- The adapter never reports `Expired`, which ADR 0005 keeps in the closed set for adapters that can
  tell. `errors/bad-credentials` accepts `attempts` of `1` or `2`, as ADR 0021 already amended it.
  The `Expired` conformance case reports itself skipped against GCS, and a unit test with a fake
  `fetch` asserts the repeat: one `401` with `error=invalid_token`, one resolver call with
  `forceRefresh: true`, then success, or `InvalidCredentials` after a second `401`.
- What an expired token answers was not measured, since that needs a token past its hour. It joins
  the open points of spec section 14 for a scheduled run. Should it carry a signal of its own, such
  as an `error_description`, a genuine `Expired` can be added in a minor release. The first run
  against the bucket asked with a token of a 60-second lifetime past its expiry and saw the answer
  a made-up token gets, `401` with `error=invalid_token`, the reason `authError` and "Invalid
  Credentials", from the second it expired, so the adapter still never reports `Expired`.
- `adapter-gcs` exports no `fromEnv`. An access token in an environment variable is a snapshot that
  stops working within an hour, the reason ADR 0021 did not read one, and
  `GOOGLE_APPLICATION_CREDENTIALS` names a file, which `workerd` cannot read.
- `bucket` is the one required option beside `credentials`. There is no `project`: no object
  operation of the JSON API names it, and `signBlob` addresses its service account under
  `projects/-`. `endpoint` is optional and defaults to `https://storage.googleapis.com`; given, it
  follows the rules of `adapter-s3` — an absolute URL without userinfo, query or fragment, `https:`
  always and `http:` only on a loopback host, and a path becomes the prefix of every request path.
  That reaches fake-gcs-server and other universes, which stay configurable and not promised.
  Nothing is read from the host. The host of the URLs the adapter signs is decided with presigned
  URLs.
- The credential takes no cell of the runtime matrix away: a bearer token is one header.
- The README leads with a resolver around a `google-auth-library` `GoogleAuth` client, three lines
  that pass `forceRefresh` on to a forced refresh of the client, with the scope
  `https://www.googleapis.com/auth/devstorage.read_write`, which covers every object operation
  without `full_control`. It says that the library loads on `workerd` only under `nodejs_compat`,
  and that without it the token comes from a resolver of the caller's own. It shows no key exchange.
- Token acquisition ships in no form, from a key, the metadata server or workload identity
  federation. Those resolvers belong to a credential bridge, which the map puts outside v0.3.
- The slow tier of ADR 0012 exercises the access token against the real bucket. How the scheduled
  run obtains it is decided with the conformance endpoint.
- Whether a chunk sent to a resumable upload's session URI carries the token is decided with
  uploads. ADR 0036 decides that it carries none, since the session URI authorizes it and the
  service checks no token there; the credential is resolved once, for the session's start.
- ADR 0038 narrows `403` to `AccessDenied` except for an object under a hold or a retention
  policy, which is `ProviderError`.
