# On GCS a signer is named beside the credential, and it signs with a key of its own or through `signBlob`

ADR 0011 holds on Google Cloud Storage, and ADR 0022's `PresignedPut` carries over unchanged. What
differs is who signs. On S3 and Azure the credential that authenticates requests can sign a URL;
on GCS the access token of ADR 0033 cannot, because a bearer token names no one to sign as and V4
signed URLs are signed by a service account. `@stowage/adapter-gcs` therefore takes a signer as an
option of its own beside `credentials`, and a storage without one has no presigned URLs:

```ts
export type GcsSigner =
  | { serviceAccount: string; privateKey: Resolvable<string | CryptoKey> }
  | { serviceAccount: string; credentials: Resolvable<GcsCredentials> };
```

`serviceAccount` is the service account's email, the authorizer in `X-Goog-Credential`. With
`privateKey` the adapter signs `GOOG4-RSA-SHA256` locally with Web Crypto, from the PKCS#8 PEM that a
JSON key file holds as `private_key` or from a `CryptoKey`, which admits a key that cannot be
exported. With `credentials` it asks `signBlob` of the IAM Credentials API to sign as that service
account, under a token of its own. The adapter tells the two apart by the field present, as the
Azure adapter tells its credentials apart. The local key is what the per-commit run of ADR 0034
signs with, against an emulator that checks no signature; `signBlob` is what the real bucket signs
with, since a key there would be a stored secret, and it is the way Google recommends. HMAC was the
third way and is not taken: organizations created since 2024-05-03 block service-account HMAC keys
by default, Google's own tools sign no URL with HMAC, `GOOG4-HMAC-SHA256` has no published vectors,
and it would be a second algorithm to build for the least recommended credential. It can join the
union in a minor release.

The token for `signBlob` is required rather than borrowed from the storage's `credentials`.
`signBlob` needs the scope `iam` or `cloud-platform`, and the storage token the README leads with
has `devstorage.read_write` alone, so a default would fail with `403` for every caller who followed
the README. Two scopes are two tokens in the ordinary case, as they are in the harness; a caller
holding a `cloud-platform` token, such as one from the metadata server, passes the same resolver
twice.

`gcsStorage` is overloaded on the option: given `signer`, it returns `GcsSigningStorage`, which is
`GcsStorage` with `presignGet` and `presignPut`, and without it `GcsStorage`, which carries neither.
Spec 4.9 ties a missing `presignedUrls` to missing methods on the type, and ADR 0032 declares the
capability only where a signer is configured, so the type follows the option that decides the
declaration. It is no type parameter over the capability, which spec 4.9 rules out. Methods present
on the type and absent at runtime would have let `"presignGet" in storage` contradict the type, and
methods that reject with `Unsupported` would have broken the inverted case of ADR 0015. A caller who
passes `signer` from a variable typed `GcsSigner | undefined` gets `GcsStorage`, a type narrower
than the runtime, which is the safe direction.

The points the research left open were measured against the measurement bucket on 2026-09-28,
signing with the bucket's HMAC key, whose canonical request is the one `GOOG4-RSA-SHA256` signs
(`spikes/gcs-presign/` on branch `spike/gcs-presign`). A signed `content-length` binds exactly: a body
one byte longer or shorter answers `403 SignatureDoesNotMatch`, and with `content-length` unsigned
any length passes. `content-type` is compared byte for byte, parameters and case included. An
expired URL answers `400 ExpiredToken` on `GET` and `PUT` alike. Every refusal from an allowed
origin carries the rule's `access-control-allow-origin`.

## Consequences

- The signer is not `Resolvable` as a whole: it decides the declaration at construction.
  `serviceAccount` must be a non-empty string, and a missing, empty or unknown field is
  `InvalidOption` at construction. `privateKey` and the signer's `credentials` are resolved on every
  presign call and cached nowhere, as ADR 0007 has it. A `privateKey` that is not a PKCS#8 PEM or an
  RSA `CryptoKey` able to sign is `InvalidCredentials` naming `privateKey`, with `attempts: 0`.
- Under a local key neither method sends a request. Under `signBlob` each call sends one request to
  `iamcredentials.googleapis.com` and keeps nothing, since every URL signs another string. It is an
  ordinary request of the adapter: ADR 0013 retries it, a `401` with `error=invalid_token` is
  repeated once with `forceRefresh` on the signer's `credentials` as ADR 0033 has it, and `403` is
  `AccessDenied`, including a service account that does not exist, which IAM answers with `403`.
  The key and the options are checked before it, so `presign/expires-in-bounds` sends no request.
- The principal behind a `signBlob` token needs `iam.serviceAccounts.signBlob` on the named service
  account, which Service Account Token Creator grants, and the data role for the operation it signs.
- `expiresIn` keeps 1 to 604800 seconds; GCS refuses `604801` with `400`. Google guarantees the key
  behind `signBlob` for 12 hours after it signs and rotates it at a time the caller does not learn,
  so a URL signed that way may stop working after 12 hours. That is ADR 0007's rule, a URL expires
  with the credential that signed it, with that credential's expiry hidden. Capping `expiresIn` at
  43200 under `signBlob` was the alternative; it would have made the bound depend on the signer for a
  rotation that is only probabilistic, and Google's own clients sign seven days through `signBlob`.
- A URL signed with a local key works until it expires or the key is deleted.
- `X-Goog-Date` is the signing moment and is not dated back. Expiry counts from it exactly, so
  dating it back would take lifetime from the URL, and GCS accepts a date up to about 15 minutes
  ahead of its clock (measured: 14 minutes accepted, 16 refused with `403 AccessDenied`). A signer
  whose clock runs slow shortens the URL by that much.
- The URL is path-style, `<endpoint>/<bucket>/<key>`, with the prefix of a configured `endpoint`
  kept, and its scheme and host are the endpoint's: `https://storage.googleapis.com` by default,
  `http://127.0.0.1:<port>` against fake-gcs-server, the regional host where one is configured. This
  is the configurable host ADR 0034 asked for, and it needs no option of its own. Virtual-hosted
  URLs and custom domains are not offered; a `signedUrlEndpoint` option can add them in a minor
  release. The scope location is `auto`, as Google's Node signer has it.
- `presignGet` signs `GET` on an addressable key and takes `GcsPresignGetOptions`: `expiresIn`,
  `responseContentType` and `responseContentDisposition`, sent as `response-content-type` and
  `response-content-disposition`. GCS ignores `response-cache-control` and `response-expires`, as the
  XML spike and this probe both saw, so neither is on the type. `responseContentDisposition` is not
  checked for ASCII; GCS returns it byte for byte, which a `fetch` reads as Latin-1, and the spec
  points to `filename*=UTF-8''…` of RFC 6266 for names outside ASCII. A test of the adapter in the
  `slow` tier asserts both overrides against the real bucket, as ADR 0011 and ADR 0022 have it for
  S3 and Azure, because fake-gcs-server honors none.
- `presignPut` signs `PUT` on a writable key with `X-Goog-SignedHeaders=content-length;content-type;host`
  and returns `headers` holding `content-type` alone. A body of another length or another content
  type answers `403 SignatureDoesNotMatch`; an existing object is overwritten. The keys ADR 0032
  refuses are `InvalidKey` here too, before signing.
- There is no length range. GCS enforces a signed `x-goog-content-length-range` header, which is the
  `content-length-range` condition ADR 0011 gave up with POST policies, but only as a header: the
  same range as a query parameter is not enforced. As a header it is one more name the bucket's CORS
  rule must allow, or the preflight fails, and it would be an option on GCS alone. A
  `maxContentLength` option on `GcsPresignPutOptions` can add it in a minor release.
- Flow 2 on GCS requires a CORS rule on the bucket with the uploading origin, `PUT` and
  `Content-Type`. stowage states it and sets none. GCS answers a refused or expired upload from an
  allowed origin with the rule's CORS headers, so a page reads the status. The conformance bucket's
  rule of ADR 0034 stays as it is, and its `slow` test of a preflight and an expired `PUT` from the
  CORS origin stays as a guard on that behavior.
- `presign/expired-url` asserts that the expired URL answers `400` or `403`, and it signs a control
  URL with `expiresIn: 60` in the same case that must answer `200`. This contradicts ADR 0031, which
  counted "accepting both would loosen the case for every provider" against `adapter-s3` over the XML
  API; the reason no longer holds, because `adapter-gcs` signs XML-host URLs too and GCS is promised,
  so the case must pass there. The control URL closes the loosening ADR 0031 feared: a URL broken
  for another reason, such as `400 MalformedSecurityHeader`, fails the control rather than passing
  as expired. Spec 10.5 changes for every provider; AWS S3, R2 and Azure still answer `403`.
- The GCS target signs with a `privateKey` against fake-gcs-server, a `CryptoKey` the harness
  generates at the start of the run, and with `signBlob` against the real bucket, under the second
  token of ADR 0034 at the scope `iam`. Google's 40 RSA V4 vectors check the local signer per commit.
  Nothing runs a local key against the real bucket: the canonical request is the one `signBlob`
  signs, and only the signature step differs.
- No new export reaches `@stowage/core`. `PresignedPut` is already there, and the V4 signer stays in
  the adapter, as ADR 0031 has it.
