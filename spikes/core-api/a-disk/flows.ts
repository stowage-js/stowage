// PROTOTYPE — the five reference flows of #4, written against variant A.

import type { GetOptions, ObjectStat } from "../shared/data.ts";
import { Storage, fs, s3, type StorageAdapter } from "./api.ts";

const credentials = { accessKeyId: "AKIA…", secretAccessKey: "…" };

/** The type an application writes against when it does not care which provider it got. */
type AnyStorage = Storage<StorageAdapter<any>>;

// ---------- 1. Large upload from a server ----------

export async function uploadExport(
  body: ReadableStream<Uint8Array>,
  signal: AbortSignal,
): Promise<ObjectStat> {
  const reports = new Storage(s3({ bucket: "reports", region: "eu-central-1", credentials }));
  return reports.put("2026/09/export.csv", body, {
    contentType: "text/csv",
    storageClass: "STANDARD_IA", // typed through S3Extensions, but only because `new Storage(s3(…))`
    signal, //                      kept the adapter type; a widened AnyStorage loses it
  });
}

// ---------- 2. Browser upload through a presigned PUT ----------

export async function signAvatarUpload(userId: string, contentLength: number): Promise<string> {
  // Presigning is not on the facade, so the application reaches through to the adapter.
  const avatars = s3({ bucket: "avatars", region: "eu-central-1", credentials });
  return avatars.presignPut(`users/${userId}/avatar.png`, {
    expiresIn: 300,
    contentType: "image/png",
    contentLength,
  });
}

// ---------- 3. File browser listing one prefix ----------

export async function fileBrowserPage(storage: AnyStorage, prefix: string, cursor?: string) {
  // One page is wanted; list() only offers an iterator over pages, so the handler has to open
  // the iterator by hand and drop it again.
  const pages = storage.list({ prefix, delimiter: "/", pageSize: 100, cursor });
  const first = await pages[Symbol.asyncIterator]().next();
  if (first.done) return { objects: [], folders: [], cursor: undefined };
  return {
    objects: first.value.objects,
    folders: first.value.prefixes,
    cursor: first.value.cursor,
  };
}

// ---------- 4. Streaming download from an edge runtime ----------

export async function serveObject(storage: AnyStorage, key: string, range?: GetOptions["range"]) {
  // Two round trips: get() returns the body alone, and the response needs the content type.
  const stat = await storage.stat(key);
  const body = await storage.get(key, { range });
  return new Response(body, {
    status: range ? 206 : 200,
    headers: { "content-type": stat.contentType ?? "application/octet-stream" },
  });
}

// ---------- 5. Move a prefix from the file system to S3 ----------

export async function movePrefix(prefix: string) {
  const source = new Storage(fs({ root: "/var/data/uploads" }));
  const target = new Storage(s3({ bucket: "uploads", region: "eu-central-1", credentials }));

  for await (const page of source.list({ prefix })) {
    for (const object of page.objects) {
      const body = await source.get(object.key);
      await target.put(object.key, body, { contentType: object.contentType });
    }
  }
  return source.deleteAll(prefix);
}
