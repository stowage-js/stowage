// PROTOTYPE — the five reference flows of #4, written against variant C.

import type { GetOptions, ObjectStat } from "../shared/data.ts";
import { fs, type Storage } from "./api.ts";
import { s3 } from "./adapter-s3.ts";

const credentials = { accessKeyId: "AKIA…", secretAccessKey: "…" };

// ---------- 1. Large upload from a server ----------

export async function uploadExport(
  body: ReadableStream<Uint8Array>,
  signal: AbortSignal,
): Promise<ObjectStat> {
  const reports = s3({ bucket: "reports", region: "eu-central-1", credentials });
  return reports.put("2026/09/export.csv", body, {
    contentType: "text/csv",
    storageClass: "STANDARD_IA", // from the registry, keyed by the provider name "s3"
    signal,
  });
}

// ---------- 2. Browser upload through a presigned PUT ----------

export async function signAvatarUpload(userId: string, contentLength: number): Promise<string> {
  const avatars = s3({ bucket: "avatars", region: "eu-central-1", credentials });
  return avatars.presignPut(`users/${userId}/avatar.png`, {
    expiresIn: 300,
    contentType: "image/png",
    contentLength,
  });
}

// ---------- 3. File browser listing one prefix ----------

export async function fileBrowserPage(storage: Storage, prefix: string, cursor?: string) {
  const page = await storage.list({ prefix, delimiter: "/", pageSize: 100, cursor }).page();
  return { objects: page.objects, folders: page.prefixes, cursor: page.cursor };
}

// ---------- 4. Streaming download from an edge runtime ----------

export async function serveObject(storage: Storage, key: string, range?: GetOptions["range"]) {
  const object = await storage.get(key, { range });
  return new Response(object.stream(), {
    status: range ? 206 : 200,
    headers: { "content-type": object.stat.contentType ?? "application/octet-stream" },
  });
}

// ---------- 5. Move a prefix from the file system to S3 ----------

export async function movePrefix(prefix: string) {
  const source = fs({ root: "/var/data/uploads" });
  const target = s3({ bucket: "uploads", region: "eu-central-1", credentials });

  for await (const object of source.list({ prefix })) {
    const stored = await source.get(object.key);
    await target.put(object.key, stored.stream(), { contentType: object.contentType });
  }
  return source.deleteAll(prefix);
}

// ---------- what the provider-keyed options cost ----------

/** An application written against the portable type gets no provider options at all. */
export async function portableUpload(storage: Storage, key: string, body: Uint8Array) {
  return storage.put(key, body, { contentType: "application/octet-stream" });
}
