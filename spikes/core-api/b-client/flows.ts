// PROTOTYPE — the five reference flows of #4, written against variant B.

import type { GetOptions, ObjectStat } from "../shared/data.ts";
import { fs, s3, type StorageClient } from "./api.ts";

const credentials = { accessKeyId: "AKIA…", secretAccessKey: "…" };

// ---------- 1. Large upload from a server ----------

export async function uploadExport(
  body: ReadableStream<Uint8Array>,
  signal: AbortSignal,
): Promise<ObjectStat> {
  const aws = s3({ region: "eu-central-1", credentials });
  return aws.put({ bucket: "reports", key: "2026/09/export.csv" }, body, {
    contentType: "text/csv",
    storageClass: "STANDARD_IA", // typed, because `aws` is an S3Client and nothing widened it
    signal,
  });
}

// ---------- 2. Browser upload through a presigned PUT ----------

export async function signAvatarUpload(userId: string, contentLength: number): Promise<string> {
  const aws = s3({ region: "eu-central-1", credentials });
  return aws.presignPut(
    { bucket: "avatars", key: `users/${userId}/avatar.png` },
    { expiresIn: 300, contentType: "image/png", contentLength },
  );
}

// ---------- 3. File browser listing one prefix ----------

export async function fileBrowserPage(
  client: StorageClient,
  bucket: string,
  prefix: string,
  cursor?: string,
) {
  const page = await client.listPage(bucket, { prefix, delimiter: "/", pageSize: 100, cursor });
  return { objects: page.objects, folders: page.prefixes, cursor: page.cursor };
}

// ---------- 4. Streaming download from an edge runtime ----------

export async function serveObject(
  client: StorageClient,
  bucket: string,
  key: string,
  range?: GetOptions["range"],
) {
  const object = await client.get({ bucket, key }, { range });
  return new Response(object.stream(), {
    status: range ? 206 : 200,
    headers: { "content-type": object.stat.contentType ?? "application/octet-stream" },
  });
}

// ---------- 5. Move a prefix from the file system to S3 ----------

export async function movePrefix(prefix: string) {
  const disk = fs({ root: "/var/data" });
  const aws = s3({ region: "eu-central-1", credentials });

  // "uploads" is a bucket on S3 and a directory below the root on fs: the same word, two things.
  for await (const object of disk.list("uploads", { prefix })) {
    const source = await disk.get({ bucket: "uploads", key: object.key });
    await aws.put({ bucket: "uploads", key: object.key }, source.stream(), {
      contentType: object.contentType,
    });
  }
  return disk.deleteAll("uploads", prefix);
}

// ---------- what the narrow operation set costs the caller ----------

/** B has no exists(), so every caller writes this. */
export async function exists(client: StorageClient, bucket: string, key: string) {
  try {
    await client.stat({ bucket, key });
    return true;
  } catch {
    return false; // and #14 decides which error this is allowed to swallow
  }
}

/** B has no move(), so every caller writes this, and gets the failure window wrong. */
export async function move(client: StorageClient, bucket: string, from: string, to: string) {
  await client.copy({ bucket, key: from }, { bucket, key: to });
  await client.delete({ bucket, key: from });
}
