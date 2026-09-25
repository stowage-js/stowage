# @stowage/adapter-s3

A storage in one bucket of AWS S3 or Cloudflare R2, spoken to over the S3 wire protocol rather than
through an SDK.

## Install

```sh
npm install @stowage/adapter-s3
```

## Example

A server signs a URL for one upload of the type and length the browser reported. The browser then
calls it with a plain `fetch` and `PUT`, against AWS S3 or R2 alike.

```ts
import { fromEnv, s3Storage } from "@stowage/adapter-s3";

declare const process: { readonly env: Readonly<Record<string, string | undefined>> };

const aws = s3Storage({ bucket: "my-app-uploads", region: "eu-north-1", credentials: fromEnv });

const fromR2Env = () => ({
  accessKeyId: process.env.R2_ACCESS_KEY_ID ?? "",
  secretAccessKey: process.env.R2_SECRET_ACCESS_KEY ?? "",
});

const r2 = s3Storage({
  bucket: "my-app-uploads",
  region: "auto",
  endpoint: "https://<account-id>.r2.cloudflarestorage.com",
  credentials: fromR2Env,
});

for (const storage of [aws, r2]) {
  const url = await storage.presignPut("avatars/alice.png", {
    expiresIn: 300,
    contentType: "image/png",
    contentLength: 48_213,
  });

  console.log(url);
}
```

The bucket has to allow `UNSIGNED-PAYLOAD` and carry a CORS rule for the uploading origin; stowage
configures neither
([flow 2](https://github.com/stowage-js/stowage/blob/@stowage/adapter-s3@0.1.0/docs/spec.md#flow-2-browser-upload-through-a-presigned-put)).

## Runtimes

Node 24 and later, Bun, Deno and `workerd` at the compatibility date `2026-09-01` without Node APIs. `fromEnv` reads
the environment on `workerd` under `nodejs_compat` and on Deno under `--allow-env`. CI last ran green on Bun 1.4.2 and Deno 2.9.6.

The bundle measures 13.4 kB minified and gzipped, `@stowage/core` included.

## Limits

- `keyBytesPreserved` is not declared
  ([spec 4.9](https://github.com/stowage-js/stowage/blob/@stowage/adapter-s3@0.1.0/docs/spec.md#49-capabilities)).
  R2 normalizes a key to NFC, so two Unicode-equivalent keys name one object there and two on AWS
  S3.
- `delete` sends at most one `DeleteObjects` per 1000 keys, plus at most one `DELETE` per key
  holding `U+FFFE` or `U+FFFF`, which XML carries neither raw nor as a reference
  ([spec 7.4](https://github.com/stowage-js/stowage/blob/@stowage/adapter-s3@0.1.0/docs/spec.md#74-requests)).
- Where AWS S3 and R2 answer differently, the adapter is written to the stricter side
  ([spec 7.2](https://github.com/stowage-js/stowage/blob/@stowage/adapter-s3@0.1.0/docs/spec.md#72-promised-providers)):

| Point                              | What holds                                                                                                               |
| ---------------------------------- | ------------------------------------------------------------------------------------------------------------------------ |
| Listing order                      | None. A page holds at most 1000 keys                                                                                     |
| `userMetadata`                     | 2 KB of encoded header bytes; ASCII keys                                                                                 |
| Single `PUT`                       | Up to 5 GB for a `Uint8Array` or string; a stream that fills more than one part goes as a multipart upload               |
| Object size ceiling                | The provider's, answered with `EntityTooLarge`                                                                           |
| `Content-Type`                     | Always sent by `put`, `application/octet-stream` where none was given                                                    |
| `CompleteMultipartUpload`          | Judged by its body, which may carry an error under `200`                                                                 |
| Writes per key                     | R2 answers `429` above one write per second and key; the retry may recover a single collision, but does not guarantee it |
| Incomplete multipart uploads       | Removed by a lifecycle rule on AWS, after seven days by default on R2; stowage removes none                              |
| Presigned URL host                 | The endpoint that signed it; on R2 the `r2.cloudflarestorage.com` endpoint and not a custom domain                       |
| Response overrides on `presignGet` | Answered as the four response headers, on AWS and on R2                                                                  |

## Notes

No package takes a connection URL
([spec 7.3](https://github.com/stowage-js/stowage/blob/@stowage/adapter-s3@0.1.0/docs/spec.md#73-credentials)).
A caller holding one splits it into the four options. `credentials: fromEnv` keeps the secret out of
the URL; one that stays in it has to be percent-encoded, because a `/` in the secret makes
`new URL` throw.

```ts
import { s3Storage, type S3Storage } from "@stowage/adapter-s3";

// s3://<access-key-id>:<secret-access-key>@<bucket>?region=<region>&endpoint=<endpoint>
export function s3StorageFromUrl(connection: string): S3Storage {
  const url = new URL(connection);
  const region = url.searchParams.get("region");

  // The message quotes nothing of the URL, which carries the secret.
  if (region === null) throw new Error("The connection URL names no region");

  return s3Storage({
    bucket: url.hostname,
    region,
    endpoint: url.searchParams.get("endpoint") ?? undefined,
    credentials: {
      accessKeyId: decodeURIComponent(url.username),
      secretAccessKey: decodeURIComponent(url.password),
    },
  });
}
```

`put` takes no `Blob`. A caller holding one passes its stream
([spec 4.2](https://github.com/stowage-js/stowage/blob/@stowage/adapter-s3@0.1.0/docs/spec.md#42-bodies)):

```ts
import { fromEnv, s3Storage } from "@stowage/adapter-s3";

const storage = s3Storage({ bucket: "my-app-uploads", region: "eu-north-1", credentials: fromEnv });
const blob = new Blob(["region,revenue\n"], { type: "text/csv" });

await storage.put("reports/2026/q3.csv", blob.stream(), { contentType: blob.type });
```

stowage reports no progress, no upload id and no resume
([spec 7.6](https://github.com/stowage-js/stowage/blob/@stowage/adapter-s3@0.1.0/docs/spec.md#76-uploads)).
A caller who wants progress counts the bytes on their way into `put`:

```ts
import { fromEnv, s3Storage } from "@stowage/adapter-s3";

const storage = s3Storage({ bucket: "my-app-uploads", region: "eu-north-1", credentials: fromEnv });

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

await storage.put("videos/intro.mp4", response.body.pipeThrough(countBytes(console.log)), {
  contentType: "video/mp4",
});
```

## Specification

[`docs/spec.md` at `@stowage/adapter-s3@0.1.0`](https://github.com/stowage-js/stowage/blob/@stowage/adapter-s3@0.1.0/docs/spec.md#7-stowageadapter-s3)
is the contract: a caller may rely on what it states and on nothing else this package happens to
export. The [terms it uses](https://github.com/stowage-js/stowage/blob/@stowage/adapter-s3@0.1.0/CONTEXT.md)
and the [decisions behind it](https://github.com/stowage-js/stowage/tree/@stowage/adapter-s3@0.1.0/docs/adr)
are at the same tag.

## License

MIT
