# @stowage/adapter-azure-blob

A storage in one container of an Azure Blob Storage account, spoken to over the Blob wire protocol
rather than through an SDK.

## Install

```sh
npm install @stowage/adapter-azure-blob
```

## Example

A server signs a URL for one upload of the type and length the browser reported. The browser then
calls it with a plain `fetch`, `PUT` and the `headers` that came with it, as it would against
`adapter-s3`.

```ts
import { azureBlobStorage } from "@stowage/adapter-azure-blob";

// An Entra ID token for the scope `https://storage.azure.com/.default`; the notes below show
// how `@azure/identity` provides one.
declare function storageAccessToken(): Promise<string>;

const storage = azureBlobStorage({
  account: "myappuploads",
  container: "avatars",
  credentials: async () => ({ accessToken: await storageAccessToken() }),
});

const { url, headers } = await storage.presignPut("alice.png", {
  expiresIn: 300,
  contentType: "image/png",
  contentLength: 48_213,
});

// In the browser, with the file of exactly that type and length:
declare const file: File;

await fetch(url, { method: "PUT", headers, body: file });
```

`presignPut` signs a user delegation SAS, which only an access token can request. The principal
behind the token needs the account's `generateUserDelegationKey` action and the data role for the
upload
([spec 8.9](https://github.com/stowage-js/stowage/blob/@stowage/adapter-azure-blob@0.3.0/docs/spec.md#89-presigned-urls)).

## Runtimes

Node 24 and later, Bun, Deno and `workerd` at the compatibility date `2026-09-01` without Node APIs. `fromEnv` reads
the environment on `workerd` under `nodejs_compat` and on Deno under `--allow-env`. CI last ran green on Bun 1.4.2 and Deno 2.9.6.

The bundle measures 14.9 kB minified and gzipped, `@stowage/core` included.

## Limits

- `userMetadataTokenKeys` is not declared: a user metadata key beyond ASCII identifiers, such as
  `content-hash`, is `Unsupported` naming it
  ([spec 4.9](https://github.com/stowage-js/stowage/blob/@stowage/adapter-azure-blob@0.3.0/docs/spec.md#49-capabilities)).
- Three kinds of writable key are `InvalidKey` before any request: one of more than 254 segments,
  one with a segment ending in `.`, and one holding a character from `U+0080` to `U+009F`. An
  addressable key and a prefix are refused by nothing beyond the key rule
  ([spec 8.1](https://github.com/stowage-js/stowage/blob/@stowage/adapter-azure-blob@0.3.0/docs/spec.md#81-construction)).
- `delete` sends at most one Blob Batch request per 256 keys
  ([spec 8.1](https://github.com/stowage-js/stowage/blob/@stowage/adapter-azure-blob@0.3.0/docs/spec.md#81-construction)).
- The promised provider is a general-purpose v2 account in the public cloud, without hierarchical
  namespace, holding block blobs. An account with hierarchical namespace, a sovereign cloud and
  another endpoint speaking the Blob wire protocol can be configured and are not promised
  ([spec 8.2](https://github.com/stowage-js/stowage/blob/@stowage/adapter-azure-blob@0.3.0/docs/spec.md#82-promised-provider)):

| Point                              | What holds                                                                                                                                     |
| ---------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------- |
| Listing order                      | None. A page holds at most 1000 names                                                                                                          |
| Unicode-equivalent keys            | Two blobs: an NFC and an NFD name are stored, listed and read apart                                                                            |
| `userMetadata`                     | ASCII identifier keys, stored and handed back in lower case; 2 KB as spec 4.3 measures them                                                    |
| Single `Put Blob`                  | Up to 5,000 MiB for a `Uint8Array` or string; a stream that fills more than one part goes as blocks                                            |
| Object size ceiling                | 50,000 blocks of at most 4,000 MiB; the upload stops at 50,000 parts                                                                           |
| `Content-Type`                     | Always sent by `put`, on the commit of a block upload as well, `application/octet-stream` where none was given                                 |
| Writes per key                     | Of two writers, one may be rejected                                                                                                            |
| Uncommitted blocks                 | Kept until the next commit or `Put Blob` to the name, or until the service discards them seven days after the last block; stowage removes none |
| Presigned URL host                 | The endpoint that signed it                                                                                                                    |
| Response overrides on `presignGet` | Answered as the three response headers; Azure has no override for `Expires`                                                                    |

## Notes

stowage acquires no token
([spec 8.3](https://github.com/stowage-js/stowage/blob/@stowage/adapter-azure-blob@0.3.0/docs/spec.md#83-credentials)).
A caller holding an `@azure/identity` credential, such as `DefaultAzureCredential`, wraps its
`getToken` in a resolver. The adapter calls the resolver before every request it signs and keeps
nothing between calls, so the caching is the credential's:

```ts
import { azureBlobStorage } from "@stowage/adapter-azure-blob";

// `new DefaultAzureCredential()` of `@azure/identity`, or any other `TokenCredential`; the
// block declares the one method it calls so that it compiles without the package.
declare const credential: {
  getToken(scopes: string): Promise<{ readonly token: string } | null>;
};

const storage = azureBlobStorage({
  account: "myappuploads",
  container: "avatars",
  credentials: async () => {
    const accessToken = await credential.getToken("https://storage.azure.com/.default");

    if (accessToken === null) throw new Error("No access token for Azure Storage");

    return { accessToken: accessToken.token };
  },
});
```

An account key signs with Shared Key instead. `credentials: fromEnv` reads it from
`AZURE_STORAGE_KEY`; the account name stays configuration. Microsoft
[advises against Shared Key](https://learn.microsoft.com/en-us/azure/storage/common/shared-key-authorization-prevent)
and recommends Entra ID for every account that can do without it: a key grants everything on the
account and lives until it is regenerated. An account that disallows Shared Key answers
`InvalidCredentials`
([spec 8.3](https://github.com/stowage-js/stowage/blob/@stowage/adapter-azure-blob@0.3.0/docs/spec.md#83-credentials)),
and `presignPut` refuses an account key before any request
([spec 8.9](https://github.com/stowage-js/stowage/blob/@stowage/adapter-azure-blob@0.3.0/docs/spec.md#89-presigned-urls)).

```ts
import { azureBlobStorage, fromEnv } from "@stowage/adapter-azure-blob";

const storage = azureBlobStorage({
  account: "myappuploads",
  container: "avatars",
  credentials: fromEnv,
});
```

No package takes a connection string. A caller holding one splits it into `account`, `endpoint`
and `credentials`. A string carrying `SharedAccessSignature` holds a SAS, which no package takes
as a credential either.

```ts
import { azureBlobStorage, type AzureBlobStorage } from "@stowage/adapter-azure-blob";

// DefaultEndpointsProtocol=https;AccountName=<account>;AccountKey=<key>;EndpointSuffix=core.windows.net
export function azureBlobStorageFromConnectionString(
  connection: string,
  container: string,
): AzureBlobStorage {
  const fields = new Map<string, string>();

  // An account key is base64 and may end in `=`, so a pair splits at its first `=` alone.
  for (const pair of connection.split(";")) {
    const separator = pair.indexOf("=");

    if (separator > 0) fields.set(pair.slice(0, separator), pair.slice(separator + 1));
  }

  const account = fields.get("AccountName");
  const accountKey = fields.get("AccountKey");

  // The message quotes nothing of the string, which carries the key.
  if (account === undefined || accountKey === undefined) {
    throw new Error("The connection string names no AccountName or no AccountKey");
  }

  const protocol = fields.get("DefaultEndpointsProtocol") ?? "https";
  const suffix = fields.get("EndpointSuffix");
  const endpoint =
    fields.get("BlobEndpoint") ??
    (suffix === undefined ? undefined : `${protocol}://${account}.blob.${suffix}`);

  return azureBlobStorage({ account, container, endpoint, credentials: { accountKey } });
}
```

A browser upload through `presignPut` is preflighted, so the account needs a CORS rule for the
Blob service that allows the uploading origin, `PUT`, and the headers `content-type` and
`x-ms-blob-type`. stowage configures none
([flow 2](https://github.com/stowage-js/stowage/blob/@stowage/adapter-azure-blob@0.3.0/docs/spec.md#flow-2-browser-upload-through-a-presigned-put)).
With the Azure CLI:

```sh
az storage cors add --account-name myappuploads --services b \
  --origins https://app.example.com --methods PUT \
  --allowed-headers content-type x-ms-blob-type --max-age 3600
```

A `put` of a stream that fills more than one part stages blocks and commits them. When it rejects
with `ProviderError` whose `providerCode` is `InvalidBlockList`, another writer usually committed
to the same key in between: the key holds that writer's object, and the error is not retryable
([spec 8.6](https://github.com/stowage-js/stowage/blob/@stowage/adapter-azure-blob@0.3.0/docs/spec.md#86-uploads)).
A caller whose object has to win puts it again from its source, since the stream is spent.

`put` takes no `Blob`. A caller holding one passes its stream
([spec 4.2](https://github.com/stowage-js/stowage/blob/@stowage/adapter-azure-blob@0.3.0/docs/spec.md#42-bodies)):

```ts
import { azureBlobStorage, fromEnv } from "@stowage/adapter-azure-blob";

const storage = azureBlobStorage({
  account: "myappuploads",
  container: "reports",
  credentials: fromEnv,
});
const blob = new Blob(["region,revenue\n"], { type: "text/csv" });

await storage.put("2026/q3.csv", blob.stream(), { contentType: blob.type });
```

stowage reports no progress, no block list and no resume
([spec 8.6](https://github.com/stowage-js/stowage/blob/@stowage/adapter-azure-blob@0.3.0/docs/spec.md#86-uploads)).
A caller who wants progress counts the bytes on their way into `put`:

```ts
import { azureBlobStorage, fromEnv } from "@stowage/adapter-azure-blob";

const storage = azureBlobStorage({
  account: "myappuploads",
  container: "videos",
  credentials: fromEnv,
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

[`docs/spec.md` at `@stowage/adapter-azure-blob@0.3.0`](https://github.com/stowage-js/stowage/blob/@stowage/adapter-azure-blob@0.3.0/docs/spec.md#8-stowageadapter-azure-blob)
is the contract: a caller may rely on what it states and on nothing else this package happens to
export. The [terms it uses](https://github.com/stowage-js/stowage/blob/@stowage/adapter-azure-blob@0.3.0/CONTEXT.md)
and the [decisions behind it](https://github.com/stowage-js/stowage/tree/@stowage/adapter-azure-blob@0.3.0/docs/adr)
are at the same tag.

## License

MIT
