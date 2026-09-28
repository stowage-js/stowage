# The GCS adapter implements the JSON API itself

Google Cloud Storage arrives as `@stowage/adapter-gcs`, which speaks the JSON API directly —
`storage/v1` and `upload/storage/v1` — and ships no runtime dependency. It does not arrive as a
promised provider of `@stowage/adapter-s3`, although the XML API is close enough to S3 that the
unchanged adapter passed 78 of 82 cases against a real bucket and 295 of 299 after three throwaway
changes. ADR 0003's exception does not apply either: every GCS scheme — bearer tokens, HMAC, and
V4 signatures by RSA — is reachable with `fetch` and Web Crypto, Google's 40 RSA V4 vectors
reproduce on Node, Bun, Deno and `workerd`, and what sits outside web standards is how a
credential arrives: key and credential-configuration files, Kubernetes token files, PKCS#12 and
mTLS federation. Under ADR 0007 those belong to a resolver the caller writes.

`adapter-s3` over the XML API lost on three counts. GCS accepts `responseCacheControl` and
`responseExpires` on a presigned `GET` and ignores both, so the response carries
`private, max-age=0` and the response date. No provider-blind fix exists: dropping the two
overrides for every provider takes them from AWS and R2 callers because of a third provider,
against ADR 0017, and honouring them everywhere but GCS means knowing the provider, against ADR 0014. A capability does not help, because a provider-blind adapter cannot declare against one
endpoint what holds against another — the reason `adapter-s3` does not declare
`keyBytesPreserved`. Second, the XML API authenticates `adapter-s3` through HMAC keys alone, which
belong to service accounts and which organizations created since 2024-05-03 block by default,
where Google recommends OAuth tokens. The scheduled run reaches its bucket through workload
identity federation, which yields a bearer token and not an HMAC key, so a promise on HMAC would
have the run store a key or mint one per run. Third, an expired presigned URL answers
`400 ExpiredToken` where spec 10.5 asserts `403`, and accepting both would loosen the case for
every provider.

An own adapter on the XML API would have kept the S3 shape with bearer tokens, and it would be a
second `adapter-s3` without a per-commit endpoint: no emulator serves the XML API. On the JSON API
fake-gcs-server does, so every commit runs the whole surface the adapter sends. Either own adapter
dissolves the overrides problem, because ADR 0011 keeps `presignGet` on the concrete adapter type
and `adapter-gcs` gives it an options type of its own without the two overrides GCS ignores.

`@google-cloud/storage` 8.2.0 underneath has the form ADR 0003 and ADR 0019 refused. The service's
reason sits in `ApiError.errors[0].reason`, in the raw `message` alone on a media download, and in
`GaxiosError.response.data` with `code` undefined on a resumable upload. Retry is two nested
engines whose predicate is replaceable and whose loop is not; `maxRetries: 0` silently means 3,
and one `save` without a precondition turns retries off for the whole shared `Storage`. A
`download()` meeting a retried `503` crashes the process past the caller's `try` on every runtime.
On `workerd` it runs only under `nodejs_compat`, because `google-auth-library` loads
`node:child_process`, and it comes to 12 to 17 times the size of `adapter-s3`.

The JSON API is narrower than the XML API in places, and the adapter takes that rather than
mixing the two. A resumable upload sends its chunks one after another in multiples of 256 KiB,
with no parts in flight side by side; a batch carries 100 calls; and a `get` may need a second
request for user metadata. The XML API's multipart upload would buy parallel parts, and it would
be the one path no per-commit run covers, on the operation most likely to leave something behind.
ADR 0016 already declares the number of parts in flight unreliable, so sequential chunks are a
bound and not a withdrawal.

## Consequences

- No published package has a runtime dependency, and ADR 0008's promise holds for seven packages.
  `@stowage/adapter-gcs` joins the `fixed` version group of ADR 0008.
- The adapter sends requests to the JSON API alone. The XML host appears only as the target of
  the URLs it signs, since V4 signed URLs exist there and nowhere else, and the adapter builds
  them without a request of its own. Whether it calls `signBlob` on `iamcredentials.googleapis.com`
  to sign under a token is left to the decisions on credentials and presigned URLs.
- `google-auth-library` is not a dependency in any form. A caller who holds one of its clients
  wraps it in a resolver of their own, and a credential bridge stays outside v0.3.
- Nothing new reaches the exports of `@stowage/core` for adapter authors through this decision.
  The V4 signer stays in `adapter-gcs`, as ADR 0019 keeps signers in their adapters, although
  `GOOG4-RSA-SHA256` and `GOOG4-HMAC-SHA256` build the canonical request and the string to sign
  almost as SigV4 does: prefixes, scope and header names differ, and a shared canonicalizer would
  be a versioned surface for two variants nobody else needs. A piece that uploads or presigning
  later find both adapters need follows ADR 0019's rule.
- The adapter uses `withRetry` and the transient conditions of ADR 0013. GCS documents `408`,
  `429` and `5xx` as the failures to repeat, which is the group ADR 0013 already has, and sends no
  `Retry-After`.
- Nothing the adapter does needs a Node API, so the decision itself takes no cell of the runtime
  matrix of ADR 0002 away. Which cells the adapter promises is decided separately.
- The per-commit endpoint is fake-gcs-server, with an exception to ADR 0012 because it checks no
  credential and no signed URL. Its pin, the cases that run against the real bucket alone and the
  divergence list are the conformance endpoint's own decision.
- GCS through `adapter-s3` is an S3-compatible endpoint like any other: configurable and not
  promised, as ADR 0003 has it. The spike's one provider-blind finding, `404 NoSuchPart` for a
  completion naming an unknown part, belongs in `adapter-s3`'s code table and is outside v0.3.
- `@stowage/adapter-gcs-sdk`, built on the official SDK, is the way back, with the two triggers
  ADR 0003 names for `@stowage/adapter-s3-sdk`: a promised provider needs behavior that cannot be
  written here in reasonable time, or wire-level defects reach users repeatedly instead of the
  conformance suite. It would carry its own ADR, join the same version group and pass the same
  conformance suite. Until Google ships a build without Node APIs, its `workerd` cell would need
  `nodejs_compat`.
- ADR 0035 accepts `400` or `403` for an expired URL after all, because `adapter-gcs` signs URLs
  for the XML host as well, and closes the loosening feared above with a control URL that must
  answer `200` in the same case.
