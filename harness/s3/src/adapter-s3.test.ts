import { randomUUID } from "node:crypto";

import {
  AbortMultipartUploadCommand,
  ListMultipartUploadsCommand,
  PutObjectCommand,
  S3Client,
} from "@aws-sdk/client-s3";
import { afterEach, describe, expect, test, vi } from "vitest";

import {
  fromEnv,
  type S3AdapterOptions,
  type S3Storage,
  s3Storage,
} from "../../../packages/adapter-s3/src/index.ts";
import { configuredStorage } from "./environment.ts";

// Spec 8.4: promises of `adapter-s3` that the core API cannot observe, held against the
// endpoint of ADR 0012. Without one these are skipped: `conformance.test.ts` already
// fails that run once, which is the failure ADR 0012 asks for.
const configured = configuredStorage();

const mebibyte = 1024 * 1024;

/** The smallest part spec 7.1 accepts, which keeps each multipart upload at three parts. */
const partSize = 5 * mebibyte;

const uploadTimeout = 60_000;

/** The longest key AWS S3 and R2 hold, in UTF-8 bytes. */
const longestKey = 1024;

function endpoint(): S3AdapterOptions {
  if (configured === undefined) throw new Error("No S3 endpoint is configured");

  return configured;
}

const storage = (): S3Storage => s3Storage({ ...endpoint(), multipart: { partSize } });

/** The writer spec 8.4 names: another tool, holding its own idea of what a key may be. */
function sdkClient(): S3Client {
  const { endpoint: url, region, forcePathStyle } = endpoint();

  return new S3Client({ endpoint: url, region, forcePathStyle, credentials: fromEnv() });
}

/** `size` bytes that end in a break of the stream rather than in its close. */
function streamBreakingAfter(size: number): ReadableStream<Uint8Array> {
  let pulled = 0;

  return new ReadableStream({
    pull(controller) {
      if (pulled >= size) {
        controller.error(new Error("The source broke"));
        return;
      }

      controller.enqueue(new Uint8Array(mebibyte).fill(pulled / mebibyte));
      pulled += mebibyte;
    },
  });
}

/** `size` bytes that close, one mebibyte at a time. */
function streamOf(size: number): ReadableStream<Uint8Array> {
  let pulled = 0;

  return new ReadableStream({
    pull(controller) {
      if (pulled >= size) {
        controller.close();
        return;
      }

      controller.enqueue(new Uint8Array(mebibyte).fill(pulled / mebibyte));
      pulled += mebibyte;
    },
  });
}

type Step = "part 2" | "complete";

/** Which request of a multipart upload a `fetch` call is, where it is one this file steers. */
function stepOf(url: string, init: RequestInit | undefined): Step | undefined {
  const query = new URL(url).searchParams;

  if (init?.method === "PUT" && query.get("partNumber") === "2") return "part 2";
  if (init?.method === "POST" && query.has("uploadId")) return "complete";

  return undefined;
}

/** The endpoint as it is, except for the one request `intercept` answers in its place. */
function interceptStep(step: Step, intercept: () => Promise<Response>): void {
  const forward = globalThis.fetch;

  vi.stubGlobal("fetch", async (url: string, init?: RequestInit): Promise<Response> => {
    if (stepOf(url, init) === step) return await intercept();

    return await forward(url, init);
  });
}

async function uploadsBelow(prefix: string): Promise<{ key: string; uploadId: string }[]> {
  const listing = await sdkClient().send(
    new ListMultipartUploadsCommand({ Bucket: endpoint().bucket, Prefix: prefix }),
  );

  return (listing.Uploads ?? []).map((upload) => ({
    key: upload.Key ?? "",
    uploadId: upload.UploadId ?? "",
  }));
}

describe.skipIf(configured === undefined)("adapter-s3 against the endpoint", () => {
  const prefix = `adapter-s3-${randomUUID()}/`;

  afterEach(async () => {
    vi.unstubAllGlobals();

    await Promise.all(
      (await uploadsBelow(prefix)).map(
        async ({ key, uploadId }) =>
          await sdkClient().send(
            new AbortMultipartUploadCommand({
              Bucket: endpoint().bucket,
              Key: key,
              UploadId: uploadId,
            }),
          ),
      ),
    );
    await storage().deleteAll(prefix);
  });

  test(
    "an upload whose stream breaks partway leaves no multipart upload behind",
    async () => {
      const key = `${prefix}broken-source.bin`;

      await expect(
        storage().put(key, streamBreakingAfter(2 * partSize + mebibyte)),
      ).rejects.toThrow("The source broke");

      expect(await uploadsBelow(key)).toEqual([]);
      expect(await storage().exists(key)).toBe(false);
    },
    uploadTimeout,
  );

  test(
    "an upload whose part spent its budget leaves no multipart upload behind",
    async () => {
      const key = `${prefix}failed-part.bin`;

      interceptStep("part 2", async () => new Response(null, { status: 503 }));

      await expect(storage().put(key, streamOf(3 * partSize))).rejects.toMatchObject({
        code: "ProviderError",
        status: 503,
        attempts: 3,
      });

      vi.unstubAllGlobals();
      expect(await uploadsBelow(key)).toEqual([]);
    },
    uploadTimeout,
  );

  test(
    "an upload the caller aborted leaves no multipart upload behind",
    async () => {
      const key = `${prefix}aborted.bin`;
      const controller = new AbortController();
      const forward = globalThis.fetch;

      vi.stubGlobal("fetch", async (url: string, init?: RequestInit): Promise<Response> => {
        if (stepOf(url, init) === "part 2") controller.abort();

        return await forward(url, init);
      });

      await expect(
        storage().put(key, streamOf(3 * partSize), { signal: controller.signal }),
      ).rejects.toHaveProperty("name", "AbortError");

      vi.unstubAllGlobals();
      expect(await uploadsBelow(key)).toEqual([]);
    },
    uploadTimeout,
  );

  // Spec 7.7: the one ambiguous outcome is the one failed upload that may stay behind.
  test(
    "a completion that received no response leaves its upload to the provider",
    async () => {
      const key = `${prefix}unanswered-completion.bin`;

      interceptStep("complete", async () => {
        throw new TypeError("fetch failed");
      });

      await expect(storage().put(key, streamOf(2 * partSize + mebibyte))).rejects.toMatchObject({
        code: "NetworkError",
        attempts: 1,
      });

      vi.unstubAllGlobals();
      expect(await uploadsBelow(key)).toEqual([{ key, uploadId: expect.any(String) }]);
    },
    uploadTimeout,
  );

  // AWS S3 and R2 refuse a key above 1024 bytes with `KeyTooLongError`, and so does the
  // endpoint, so no tool writes one there: the longest key another tool can leave is 1024
  // bytes, and a key above that is read against a stubbed `fetch` in `adapter-s3`.
  test("keys another tool wrote are listed as they are and are readable", async () => {
    const folder = `${prefix}photos/`;
    const long = `${prefix}${"x".repeat(longestKey - prefix.length - "/long.txt".length)}/long.txt`;

    expect(new TextEncoder().encode(long).length).toBe(longestKey);

    const client = sdkClient();

    await client.send(
      new PutObjectCommand({ Bucket: endpoint().bucket, Key: folder, Body: new Uint8Array(0) }),
    );
    await client.send(
      new PutObjectCommand({ Bucket: endpoint().bucket, Key: long, Body: "written elsewhere" }),
    );

    const listed: string[] = [];

    for await (const entry of storage().list({ prefix })) listed.push(entry.key);

    expect(listed.toSorted()).toEqual([folder, long].toSorted());
    await expect(storage().stat(folder)).resolves.toMatchObject({ key: folder, size: 0 });
    await expect((await storage().get(long)).text()).resolves.toBe("written elsewhere");
  });
});
