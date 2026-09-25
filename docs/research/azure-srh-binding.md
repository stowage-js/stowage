# Whether `srh` binds `Content-Type` and `Content-Length` on a real Azure account

Research for issue [#123](https://github.com/stowage-js/stowage/issues/123), a child of the v0.2 map
[#104](https://github.com/stowage-js/stowage/issues/104). ADR 0022 lets `@stowage/adapter-azure-blob`
declare `presignedUrls` only if a user delegation SAS at `sv=2026-04-06` binds `Content-Type` and
`Content-Length` through `srh`. The documentation shows invented header names only, and Azurite
derives its user delegation key from a public seed, so only a real account can settle it.

Measured on **2026-09-25** between 05:57 and 06:10 UTC against `stowageconformance`
(`swedencentral`, GPv2, `Standard_LRS`), container `stowage-conformance`, from Node v24.21.0 and
Chrome 153 on macOS.

## How to read the evidence markers

| Marker         | Meaning                                                                         |
| -------------- | ------------------------------------------------------------------------------- |
| **Measured**   | A request sent to the real account on the date above, with the answer recorded. |
| **Documented** | Stated by a primary source, with a URL, or by the source code of the Azure SDK. |
| **Derived**    | Follows from measured or documented facts by reasoning written out here.        |

## Answer

**`srh=content-type,content-length,x-ms-blob-type` binds all three headers, and ADR 0022's
fallback does not apply: the Azure adapter declares `presignedUrls` and carries both methods.**
Azure rebuilds the string to sign from the values the request actually carries and compares
signatures, so another content type, a body of another length and another blob type each fail with
`403 AuthenticationFailed`, while the signed values answer `201`. It holds the same way when Chrome
computes `Content-Length` from a `Uint8Array`, a string or a `File`. The user delegation key's
`Value` is base64-decoded before it becomes the HMAC key. The `403` carries
`Access-Control-Allow-Origin` for an origin the account's CORS rule allows, both for a deviating
request and for an expired URL.

## The user delegation key

**Measured.** `POST /?restype=service&comp=userdelegationkey` under an Entra access token for
`https://storage.azure.com`, with `x-ms-version: 2026-04-06`, answers `200`. `SignedStart` and
`SignedExpiry` echo the requested `Start` and `Expiry` to the second, `SignedService` is `b`,
`SignedVersion` is `2026-04-06`, and `Value` is 44 base64 characters, 32 bytes decoded.

**Measured.** A SAS signed with the UTF-8 bytes of `Value` as the HMAC key is refused with
`403 AuthenticationFailed`; the same SAS signed with the decoded bytes answers `201`. The Azure SDK
does the same (`Buffer.from(userDelegationKey.value, "base64")` in `UserDelegationKeyCredential` of
`@azure/storage-common`, **Documented** in its source).

## The string to sign

**Documented**, <https://learn.microsoft.com/en-us/rest/api/storageservices/create-user-delegation-sas>:
the `2026-04-06` form is `sp`, `st`, `se`, canonicalized resource, `skoid`, `sktid`, `skt`, `ske`,
`sks`, `skv`, `saoid`, `suoid`, `scid`, `skdutid`, `sduoid`, `sip`, `spr`, `sv`, `sr`, snapshot time,
`ses`, canonicalized signed request headers, canonicalized signed request query parameters, `rscc`,
`rscd`, `rsce`, `rscl`, `rsct`, joined with `\n`.

**Measured.** The canonicalized signed request headers are `name:value\n` for each name in the order
`srh` lists them, so the field ends with its own `\n` before the joining one. A signer on `fetch` and
Web Crypto built this way produced the same string to sign, signature and query parameters as
`generateBlobSASQueryParametersInternal` of `@azure/storage-blob` 12.33.0, offline, and Azure
accepted it. Listing the three names in reverse order in both `srh` and the string to sign also
answers `201`: the order is free as long as the two agree.

**Measured.** A refused signature comes back with `AuthenticationErrorDetail` holding the string to
sign Azure computed, with the request's header values in it and the middle of `skoid` masked by
`X`. That is how each refusal below shows which value Azure read.

## Uploads from Node

**Measured.** One user delegation SAS per case, `sp=w`, `st` 15 minutes in the past, `spr=https`,
`srh=content-type,content-length,x-ms-blob-type`, signed for `content-type: text/plain`,
`content-length: 11` and `x-ms-blob-type: BlockBlob`. Bodies are `Uint8Array`s, so `fetch` adds no
content type of its own and derives `Content-Length` from the body.

| Request                                                     | Status | `x-ms-error-code`       | What the detail says                                        |
| ----------------------------------------------------------- | ------ | ----------------------- | ----------------------------------------------------------- |
| Signed type, 11 bytes, `BlockBlob`                          | `201`  |                         |                                                             |
| `content-type: application/json`                            | `403`  | `AuthenticationFailed`  | Signature did not match, `content-type:application/json`    |
| `content-type: Text/Plain`                                  | `403`  | `AuthenticationFailed`  | Signature did not match, `content-type:Text/Plain`          |
| `content-type: text/plain;charset=utf-8`                    | `403`  | `AuthenticationFailed`  | Signature did not match                                     |
| No `content-type`                                           | `403`  | `AuthenticationFailed`  | Header name content-type specified in srh but was not found |
| 12 bytes                                                    | `403`  | `AuthenticationFailed`  | Signature did not match, `content-length:12`                |
| 10 bytes                                                    | `403`  | `AuthenticationFailed`  | Signature did not match, `content-length:10`                |
| No `x-ms-blob-type`                                         | `400`  | `MissingRequiredHeader` |                                                             |
| `x-ms-blob-type: AppendBlob`                                | `403`  | `AuthenticationFailed`  | Signature did not match, `x-ms-blob-type:AppendBlob`        |
| HMAC key is `Value`'s UTF-8                                 | `403`  | `AuthenticationFailed`  | Signature did not match                                     |
| Control: no `srh`, `application/json`, 2 bytes              | `201`  |                         |                                                             |
| `srh` and canonical headers in reverse order, signed values | `201`  |                         |                                                             |

The control shows that the refusals come from `srh` and not from anything else in the SAS.

**Derived.** The content type is compared as a string, case and parameters included, as SigV4
compares a signed `content-type` on S3. A missing `x-ms-blob-type` is refused before the signature
is checked, so a client that drops the headers `PresignedPut` hands it meets `400`, not `403`.

## Uploads from Chrome

**Measured.** The page was served from the account itself through a read SAS without `srh`, so the
uploads were same-origin and the page could read every status and `x-ms-error-code`; the CORS side
is measured separately below. Chrome 153, SAS as above.

| Body                                  | Headers the page set                               | Status | `x-ms-error-code`       |
| ------------------------------------- | -------------------------------------------------- | ------ | ----------------------- |
| `Uint8Array`, 11 bytes                | `content-type`, `x-ms-blob-type`                   | `201`  |                         |
| String, 11 bytes                      | `content-type`, `x-ms-blob-type`                   | `201`  |                         |
| `File` of type `text/plain`, 11 bytes | `x-ms-blob-type` only                              | `201`  |                         |
| `File` of type `text/plain`, 12 bytes | `x-ms-blob-type` only                              | `403`  | `AuthenticationFailed`  |
| `Uint8Array`, 11 bytes                | `content-type: application/json`, `x-ms-blob-type` | `403`  | `AuthenticationFailed`  |
| `Uint8Array`, 11 bytes                | `content-type` only                                | `400`  | `MissingRequiredHeader` |

The detail of the 12-byte refusal reads `content-length:12`: Azure compared the length Chrome
computed from the `File`.

**Derived.** With a `File` body and no `content-type` header, Chrome sends the file's `type`, and a
string body with an explicit `content-type` goes out without an added charset. A server that signs
for the `type` of the file the browser will send, and a client that sends the headers of
`PresignedPut` as they are, meet the signature.

## CORS on the answers

**Measured.** From Node with an `Origin` header, against the account's one rule
(`https://conformance.stowage.invalid`, `GET` and `PUT`, `content-type` and `x-ms-blob-type`):

| Request                                                         | Status | `Access-Control-Allow-Origin`         | Other CORS headers                                                   |
| --------------------------------------------------------------- | ------ | ------------------------------------- | -------------------------------------------------------------------- |
| Preflight, allowed origin, `PUT`, `content-type,x-ms-blob-type` | `200`  | `https://conformance.stowage.invalid` | `-Allow-Methods: PUT`, `-Allow-Headers: content-type,x-ms-blob-type` |
| Preflight, another origin                                       | `403`  | none                                  | none                                                                 |
| `PUT`, signed values                                            | `201`  | `https://conformance.stowage.invalid` | none                                                                 |
| `PUT`, another content type                                     | `403`  | `https://conformance.stowage.invalid` | none                                                                 |
| `PUT`, 12 bytes                                                 | `403`  | `https://conformance.stowage.invalid` | none                                                                 |
| `PUT` to a URL whose `se` passed a minute ago                   | `403`  | `https://conformance.stowage.invalid` | none                                                                 |

**Derived.** A cross-origin page whose origin matches `Access-Control-Allow-Origin` can read the
status and body of a refused upload on Azure, including the detail of an expired URL: "Signature not
valid in the specified time frame". On R2 it cannot read the refused response. The page cannot
read `x-ms-error-code`, because it is not a CORS-safelisted response header and no
`Access-Control-Expose-Headers` comes back; reading it would take `ExposedHeaders` in the account's
rule. The expired URL keeps the same error code as a wrong signature and differs in its body detail.

## What this settles and what it leaves

- ADR 0022's condition holds: `presignPut` signs with `srh=content-type,content-length,x-ms-blob-type`
  and Azure enforces all three. Azure declares `presignedUrls`, and reference flow 2 lists Azure
  without the condition ADR 0026 attached.
- The user delegation key's `Value` is base64-decoded into the HMAC key, as the account key is.
- The question ADR 0022 and ADR 0023 left for the first run, whether Azure sends CORS headers on the
  `403` of an expired or deviating URL, has its answer: it does, for an allowed origin. The `slow`
  tier test ADR 0023 describes keeps checking it.
- `presign/put-rejects-type` expects `403` and `presign/put-rejects-length` a status in the `4xx`
  class; Azure answers `403` to both.
- Not measured: Firefox and Safari, a truly cross-origin upload from a browser (the CORS headers
  were read from Node, which sends the same request a browser does after its preflight), and an
  account with a SAS expiration policy.

## Method

A throwaway script, outside the repository, took an Entra access token for the measuring user, who
held Storage Blob Data Contributor on the account for the duration of the run. It fetched one user
delegation key (`Start` 15 minutes back, `Expiry` three hours ahead), signed one SAS per case for a
blob under `srh-probe/<run>/`, sent the `PUT`s with `fetch`, and uploaded the browser page with the
token. The one-day lifecycle rule removes the blobs. An earlier run was discarded because a bug in
the script put `srh` on the control case and on the page's read SAS.
