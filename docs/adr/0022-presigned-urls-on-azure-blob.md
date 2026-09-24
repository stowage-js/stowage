# A presigned `PUT` hands out its URL with the headers it needs, and on Azure only an access token signs one

ADR 0011 holds on Azure Blob with two changes to its shape. `presignPut` returns the URL together
with the headers the client has to send, on every adapter. On `@stowage/adapter-azure-blob` it
signs only under an access token, because the one form of SAS that binds a request header is the
user delegation SAS, and only Entra ID obtains the key for it.

A `PUT` creates a block blob only when it carries `x-ms-blob-type: BlockBlob`, so a browser holding
nothing but a URL cannot finish reference flow 2 against Azure. `presignPut` therefore returns
`PresignedPut`, `{ url, headers }`, and the `headers` are what the client sends beside the body:
`content-type` on `adapter-s3`, and `content-type` with `x-ms-blob-type` on the Azure adapter.
`Content-Length` is never among them, since a browser sets it from the body and a page cannot.
The shape is the same on every adapter because the browser code of flow 2 is written once and must
not have to know the provider, and because the `presign/put` case of the suite reaches the method
through a `Storage` and can run only one shape. Returning the object from the Azure adapter alone
would have made both of them branch; returning a bare URL from both would have left
`x-ms-blob-type` to a README, and flow 2 would no longer be a URL "a plain `fetch` can call".
`S3Storage.presignPut` changing its return type is a breaking change that ADR 0017 prices at a
minor release below 1.0. `PresignedPut` sits among the exports of `@stowage/core` for adapter
authors, under the rule ADR 0019 set for what two adapters need. `presignGet` stays a `string`,
since a `GET` needs no header. `presignedUrls` and its inverted case in ADR 0015 do not change: the
methods are present or absent, and the declaration still describes both.

A service SAS binds permissions, one resource, a time window and response overrides, and no
request header, so a service SAS for `presignPut` would be the unbound URL ADR 0011 refused. A user
delegation SAS from `sv=2026-04-06` on binds named request headers through `srh`, and the key that
signs it comes from `Get User Delegation Key`, which accepts a bearer token only. Under ADR 0021 the
form of the credential is resolved on each call and can change between calls, while ADR 0015 fixes
a capability when the storage is constructed, so the declaration cannot follow the credential. The
Azure adapter declares `presignedUrls`, and the credential decides the call:

| Credential    | `presignGet`        | `presignPut`                             |
| ------------- | ------------------- | ---------------------------------------- |
| `accountKey`  | Service SAS         | `InvalidCredentials`, before any request |
| `accessToken` | User delegation SAS | User delegation SAS with `srh`           |

`InvalidCredentials` names `accountKey` and says that a service SAS cannot bind content type and
length and that `presignPut` needs an access token. It is the same judgement ADR 0021 made for
`KeyBasedAuthenticationNotPermitted`: the key may be right, and it is the wrong form of credential
for what was asked. `Unsupported` was the other name and would have contradicted the declaration
the same storage makes.

Under an access token a presign call sends a request, which ADR 0011 said neither method does. The
adapter requests a user delegation key for each call and keeps none: the key starts 15 minutes in
the past and expires with the SAS, so one key signs one URL. A cache would save the round trip for
the life of the key, and it would be the one piece of state the adapter carries between calls,
which ADR 0007 and ADR 0021 keep with the resolver. It can be added in a minor release without a
change to the API. Flow 2 already costs the browser a round trip to the server before the
signature, and the key request falls inside it, between the server and Azure.

## Consequences

- The SAS for `presignPut` carries `sv=2026-04-06`, `sr=b`, `sp=w` and
  `srh=content-type,content-length,x-ms-blob-type`. `w` overwrites, as a presigned `PUT` does on
  S3; `c` would refuse an existing blob. `presignGet` carries `sp=r`. Both carry `spr=https`, and
  `https,http` only where the configured `endpoint` is a loopback host, which is Azurite. Neither
  carries `sip`.
- `st` is set 15 minutes in the past, as Microsoft recommends for clock skew, and `se` is
  `expiresIn` seconds from now. An account with a SAS expiration policy requires `st` and measures
  `se − st`, so that policy sees `expiresIn + 900`. Leaving `st` out avoided the 900 seconds and
  would have made every URL fail on such an account.
- `expiresIn` keeps its 1 to 604800 seconds. The ceiling equals the seven days a user delegation
  key may live. A signing clock running ahead can push a key that expires at 604800 seconds past
  Azure's seven days, and then the key request fails, not the URL.
- Whether `srh` accepts `Content-Type` and `Content-Length` is unverified: the documentation shows
  invented header names only, and Azurite derives its user delegation key from a public seed, so it
  cannot settle the question. A real account settles it before the v0.2 spec is written. If either
  header cannot be bound, ADR 0011 holds and the Azure adapter declares no `presignedUrls` and
  carries neither method. A `presignGet` without the declaration would be half a capability that
  the inverted case of ADR 0015 cannot check.
- A URL signed under an access token outlives the token and dies with its key, at `se`. It is
  revoked by revoking the account's user delegation keys or the role assignment behind it, and
  Azure caches both for a while. A URL signed under an account key lives until `se` or until the
  key is regenerated. The spec's sentence that a URL stops working when the credential that signed
  it expires stays true, with the user delegation key as that credential.
- The principal behind the access token needs
  `Microsoft.Storage/storageAccounts/blobServices/generateUserDelegationKey/action`, at the account
  or above, and the data role for the operation it signs; a user delegation SAS grants at most what
  that role grants. A refused key request is `AccessDenied`. It is an ordinary request of the
  adapter: ADR 0013 retries it, and ADR 0021 repeats it once after `401 InvalidAuthenticationInfo`.
  Validation of the key and the options still happens before it, so `presign/expires-in-bounds`
  makes no request on Azure either.
- `AzurePresignGetOptions` carries `responseContentType`, `responseContentDisposition` and
  `responseCacheControl`, sent as `rsct`, `rscd` and `rscc`. Azure has no override for `Expires`,
  so `responseExpires` is not on the type, and `rsce` and `rscl`, which Azure has, are not either,
  because `S3Storage` carries neither. The three are asserted by a test of the Azure adapter in the
  `slow` tier against the real account, as ADR 0011 has it for the four on S3, because Azurite
  applies the overrides to any `GET`, signed or not.
- Flow 2 requires a CORS rule on the account: the uploading origin in `AllowedOrigins`, `PUT` in
  `AllowedMethods`, and `content-type` and `x-ms-blob-type` in `AllowedHeaders`. stowage states it
  and sets none, as it states the bucket's CORS configuration on S3. A `PUT` is never a
  CORS-safelisted method, so every cross-origin upload through a presigned URL is preflighted on
  every provider; `x-ms-blob-type` adds a name to the rule and not a preflight to the flow. Whether
  Azure sends CORS headers on the `403` for an expired or deviating URL, where R2 sends none, is
  left for the first run against the real account.
- A single `Put Blob` takes up to 5,000 MiB, and flow 2 has no path above it. The Azure adapter
  checks `contentLength` as `adapter-s3` does, as a finite, non-negative integer, and not against
  the provider's ceiling, which the spec states among the Azure points. The limit that matters in
  flow 2 is the application's, checked by the server before it signs.
- The presign cases of the suite run on Azure under an access token, because `presign/put` fails
  under an account key by design. Azurite accepts a bearer token only over HTTPS, so how the `fast`
  tier gets one is decided with the conformance endpoint.
