# @stowage/adapter-gcs

A storage in one bucket of Google Cloud Storage, spoken to over the JSON API rather than through an
SDK.

## Install

```sh
npm install @stowage/adapter-gcs
```

## Example

A server signs a URL for one upload of the type and length the browser reported. The browser then
calls it with a plain `fetch`, `PUT` and the `headers` that came with it, as it would against
`adapter-s3`.

```ts
import { gcsStorage } from "@stowage/adapter-gcs";

// Access tokens for the scopes `devstorage.read_write` and `iam`; the notes below show how
// `google-auth-library` provides them.
declare function storageAccessToken(): Promise<string>;
declare function iamAccessToken(): Promise<string>;

const storage = gcsStorage({
  bucket: "myapp-uploads",
  credentials: async () => ({ accessToken: await storageAccessToken() }),
  signer: {
    serviceAccount: "uploads@myapp.iam.gserviceaccount.com",
    credentials: async () => ({ accessToken: await iamAccessToken() }),
  },
});

const { url, headers } = await storage.presignPut("avatars/alice.png", {
  expiresIn: 300,
  contentType: "image/png",
  contentLength: 48_213,
});

// In the browser, with the file of exactly that type and length:
declare const file: File;

await fetch(url, { method: "PUT", headers, body: file });
```

`presignPut` exists only on a storage built with a `signer`. This one signs through `signBlob` as
the service account it names, one request per URL, under a token of its own
([spec 9.9](https://github.com/stowage-js/stowage/blob/@stowage/adapter-gcs@0.5.0/docs/spec.md#99-presigned-urls)).

## Runtimes

Node 24 and later, Bun, Deno and `workerd` at the compatibility date `2026-09-01` without Node APIs. There is no
`fromEnv`, and nothing is read from the host or the environment. CI last ran green on Bun 1.4.2 and Deno 2.9.6.

The bundle measures 14.8 kB minified and gzipped, `@stowage/core` included.

## Limits

- `presignedUrls` is declared only with a `signer`: a storage built without one is a `GcsStorage`,
  which has neither `presignGet` nor `presignPut`
  ([spec 4.9](https://github.com/stowage-js/stowage/blob/@stowage/adapter-gcs@0.5.0/docs/spec.md#49-capabilities)).
- Two kinds of writable key are `InvalidKey` before any request, since GCS refuses to store them:
  one starting with `.well-known/acme-challenge/`, and one holding `U+FFFE` or `U+FFFF`. An
  addressable key and a prefix are refused by nothing beyond the key rule
  ([spec 9.1](https://github.com/stowage-js/stowage/blob/@stowage/adapter-gcs@0.5.0/docs/spec.md#91-construction)).
- `delete` sends at most one batch request per 100 keys
  ([spec 9.1](https://github.com/stowage-js/stowage/blob/@stowage/adapter-gcs@0.5.0/docs/spec.md#91-construction)).
- `get` sends two requests side by side, the object's resource and its media download, since the
  download carries no user metadata. Where a writer replaces the object between them, `get` takes
  up to four
  ([spec 9.4](https://github.com/stowage-js/stowage/blob/@stowage/adapter-gcs@0.5.0/docs/spec.md#94-requests)).
- `userMetadata` values travel in the JSON body as written, raw Unicode included, which the JSON
  API reads back alike. A reader of the XML API sees such a value garbled: the `ü` of `grüße`
  reaches `fetch` on an XML `HEAD` as `Ã¼`
  ([spec 9.4](https://github.com/stowage-js/stowage/blob/@stowage/adapter-gcs@0.5.0/docs/spec.md#94-requests)).
- The tag of a cursor refuses a cursor of another storage, and nothing refuses one of this storage
  handed to a listing of another prefix: that listing yields an empty page rather than
  `InvalidOption`
  ([spec 9.4](https://github.com/stowage-js/stowage/blob/@stowage/adapter-gcs@0.5.0/docs/spec.md#94-requests)).
- The promised provider is a bucket in the public cloud with uniform bucket-level access and
  without hierarchical namespace, in any storage class, with soft delete or without it. A bucket
  with hierarchical namespace or dual-region turbo replication, another universe, and another
  endpoint speaking the JSON API, fake-gcs-server among them, can be configured and are not
  promised
  ([spec 9.2](https://github.com/stowage-js/stowage/blob/@stowage/adapter-gcs@0.5.0/docs/spec.md#92-promised-provider)):

| Point                              | What holds                                                                                                                                                    |
| ---------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Listing order                      | None. A page holds at most 1000 names                                                                                                                         |
| Unicode-equivalent keys            | Two objects: an NFC and an NFD name are stored, listed and read apart. `keyBytesPreserved` is declared                                                        |
| `userMetadata`                     | Any ASCII HTTP token as a key, stored in lower case and handed back as stored; values stored as written; 2 KB as spec 4.3 measures them                       |
| Single request                     | Up to 5 TiB, the ceiling of an object                                                                                                                         |
| Object size ceiling                | 5 TiB. A resumable session has no part limit; GCS refuses the chunk that crosses the ceiling                                                                  |
| `Content-Type`                     | Always sent by `put`, on the start of a resumable session as well, `application/octet-stream` where none was given                                            |
| Writes per key                     | GCS answers `429` above one write per second and name; the retry of spec 9.5 may recover a collision, but does not guarantee it. The later commit wins        |
| Incomplete uploads                 | A session whose cancel did not arrive keeps its bytes until GCS removes it a week after it started; stowage removes none                                      |
| Storage class                      | `put` and `copy` write the bucket's default class; `move` keeps the source's                                                                                  |
| Objects stored compressed          | An object another tool stored with a content coding may read decoded and longer than its `size`, which is the stored size; any range on it is `ProviderError` |
| Presigned URL host                 | The configured endpoint, path-style                                                                                                                           |
| Response overrides on `presignGet` | Answered as the two response headers; GCS ignores `response-cache-control` and `response-expires`, so `GcsPresignGetOptions` carries neither                  |

## Notes

stowage acquires no token
([spec 9.3](https://github.com/stowage-js/stowage/blob/@stowage/adapter-gcs@0.5.0/docs/spec.md#93-credentials)).
A caller holding a `google-auth-library` `GoogleAuth` client wraps it in a resolver. The adapter
calls the resolver before every request that carries the token and keeps nothing between calls,
so the caching is the client's. After GCS refused a token, the adapter calls the resolver once
more with `forceRefresh`, and the resolver passes that on as a client that holds no token yet:

```ts
import { gcsStorage } from "@stowage/adapter-gcs";

// The class of `google-auth-library`; the block declares the one method it calls so that it
// compiles without the package.
declare class GoogleAuth {
  constructor(options: { scopes: string });
  getAccessToken(): Promise<string | null | undefined>;
}

const scopes = "https://www.googleapis.com/auth/devstorage.read_write";
let auth = new GoogleAuth({ scopes });

const storage = gcsStorage({
  bucket: "myapp-uploads",
  credentials: async (options) => {
    if (options?.forceRefresh === true) auth = new GoogleAuth({ scopes });
    const accessToken = await auth.getAccessToken();
    return { accessToken: accessToken ?? "" };
  },
});
```

The scope `devstorage.read_write` covers every operation of the storage. `GoogleAuth` finds the
credential through Application Default Credentials and renews its token shortly before it
expires. It has no public method that forces a refresh on every kind of client it may choose, so
the resolver drops the client and its token, and the next call fetches one again. A
client that found no token hands over `""`, which the adapter refuses as `InvalidCredentials`
naming `accessToken` before any request.

`google-auth-library` loads on `workerd` only under `nodejs_compat`. Without it, the token comes
from a resolver of the caller's own, such as one that asks a server of theirs for it.

A `signer` signs the URLs of `presignGet` and `presignPut` as the service account it names, in one
of two forms
([spec 9.9](https://github.com/stowage-js/stowage/blob/@stowage/adapter-gcs@0.5.0/docs/spec.md#99-presigned-urls)).
With `privateKey`, a PKCS#8 PEM as a key file's `private_key` holds it or an RSA `CryptoKey`, it
signs locally and sends no request. With `credentials`, it signs through `signBlob` of the IAM
Credentials API, one request per URL. That token needs the scope `https://www.googleapis.com/auth/iam`
or `https://www.googleapis.com/auth/cloud-platform`, which the storage's token lacks, so the
resolver above with that scope builds a second one. Its principal needs
`iam.serviceAccounts.signBlob` on the service account, which the role Service Account Token
Creator grants, and the service account needs the data role for what it signs. A URL signed
through `signBlob` may stop working 12 hours after it was signed, whatever `expiresIn` asked for.

```ts
import { gcsStorage } from "@stowage/adapter-gcs";

declare function storageAccessToken(): Promise<string>;
declare function iamAccessToken(): Promise<string>;
// The `private_key` of the service account's key file, which the caller reads themselves.
declare const serviceAccountKey: string;

const credentials = async () => ({ accessToken: await storageAccessToken() });
const serviceAccount = "uploads@myapp.iam.gserviceaccount.com";

const signedLocally = gcsStorage({
  bucket: "myapp-uploads",
  credentials,
  signer: { serviceAccount, privateKey: serviceAccountKey },
});

const signedThroughSignBlob = gcsStorage({
  bucket: "myapp-uploads",
  credentials,
  signer: { serviceAccount, credentials: async () => ({ accessToken: await iamAccessToken() }) },
});

await signedLocally.presignGet("avatars/alice.png", { expiresIn: 300 });
await signedThroughSignBlob.presignGet("avatars/alice.png", { expiresIn: 300 });
```

A browser upload through `presignPut` is preflighted, so the bucket needs a CORS rule that allows
the uploading origin, `PUT`, and the header `content-type`, and `cache-control`,
`content-disposition` and `content-language` where `presignPut` binds them through `cacheControl`,
`contentDisposition` and `contentLanguage`. stowage configures none
([flow 2](https://github.com/stowage-js/stowage/blob/@stowage/adapter-gcs@0.5.0/docs/spec.md#flow-2-browser-upload-through-a-presigned-put)).
With the Google Cloud CLI:

```sh
echo '[{"origin": ["https://app.example.com"], "method": ["PUT"], "responseHeader": ["content-type"], "maxAgeSeconds": 3600}]' > cors.json
gcloud storage buckets update gs://myapp-uploads --cors-file=cors.json
```

`put` takes no `Blob`. A caller holding one passes its stream
([spec 4.2](https://github.com/stowage-js/stowage/blob/@stowage/adapter-gcs@0.5.0/docs/spec.md#42-bodies)):

```ts
import { gcsStorage } from "@stowage/adapter-gcs";

declare function storageAccessToken(): Promise<string>;

const storage = gcsStorage({
  bucket: "myapp-reports",
  credentials: async () => ({ accessToken: await storageAccessToken() }),
});
const blob = new Blob(["region,revenue\n"], { type: "text/csv" });

await storage.put("2026/q3.csv", blob.stream(), { contentType: blob.type });
```

stowage reports no progress, no session URI and no resume
([spec 9.6](https://github.com/stowage-js/stowage/blob/@stowage/adapter-gcs@0.5.0/docs/spec.md#96-uploads)).
A caller who wants progress counts the bytes on their way into `put`:

```ts
import { gcsStorage } from "@stowage/adapter-gcs";

declare function storageAccessToken(): Promise<string>;

const storage = gcsStorage({
  bucket: "myapp-videos",
  credentials: async () => ({ accessToken: await storageAccessToken() }),
});

function countBytes(report: (bytes: number) => void): TransformStream<Uint8Array, Uint8Array> {
  let bytes = 0;

  return new TransformStream({
    transform(chunk, controller) {
      bytes += chunk.byteLength;
      report(bytes);
      controller.enqueue(chunk);
    },
  });
}

const response = await fetch("https://example.com/video.mp4");

if (response.body === null) throw new Error("The response carries no body");

await storage.put("intro.mp4", response.body.pipeThrough(countBytes(console.log)), {
  contentType: "video/mp4",
});
```

## Specification

[`docs/spec.md` at `@stowage/adapter-gcs@0.5.0`](https://github.com/stowage-js/stowage/blob/@stowage/adapter-gcs@0.5.0/docs/spec.md#9-stowageadapter-gcs)
is the contract: a caller may rely on what it states and on nothing else this package happens to
export. The [terms it uses](https://github.com/stowage-js/stowage/blob/@stowage/adapter-gcs@0.5.0/CONTEXT.md)
and the [decisions behind it](https://github.com/stowage-js/stowage/tree/@stowage/adapter-gcs@0.5.0/docs/adr)
are at the same tag.

## License

MIT
