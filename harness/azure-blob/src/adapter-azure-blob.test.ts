import { afterAll, describe, expect, type TestContext, test } from "vitest";

import { azureBlobStorage } from "../../../packages/adapter-azure-blob/src/index.ts";
import { isStorageError } from "../../../packages/core/src/index.ts";
import { configuredStorage, endpointOrFail, storageUnderAccountKey } from "./environment.ts";

// ADR 0023: the account key is promised as much as the access token, and the suite runs
// under the token alone, so Shared Key is held against the endpoint here, across the
// operations of the parity core. Without one these are skipped: `conformance.test.ts`
// already fails that run once, which is the failure ADR 0012 asks for.
const underAccountKey = storageUnderAccountKey();
const underAccessToken = configuredStorage();

const prefix = `stowage-harness/${crypto.randomUUID()}/`;

/** Characters a key may hold that travel encoded, each of which the signature covers. */
const encodedPrefix = `${prefix}a b#c?d%e+f'(g)*!/`;
const encodedKey = `${encodedPrefix}grüße/日本.txt`;

/**
 * Spec 8.4: `x-ms-meta-a_` sorts before `x-ms-meta-a1` in the canonical headers, where code
 * point order has it after, and Shared Key folds a run of whitespace in a value to one
 * space, which the adapter keeps out of the header by encoding such a value.
 */
const userMetadata = { a1: "digit", a_: "a run   of spaces" };

const mebibyte = 1024 * 1024;

/** The smallest part spec 8.1 accepts, which keeps a block upload at three blocks. */
const partSize = 5 * mebibyte;

const uploadTimeout = 60_000;

/**
 * ADR 0025: under the account key the source of a copy carries a service SAS, which an
 * endpoint checks only where it carries `Put Blob From URL`. The pinned Azurite answers
 * `501`, and the test reports itself skipped until the pin moves to a release that does not.
 */
function skipWithoutPutBlobFromUrl(ctx: TestContext, failure: unknown): void {
  if (isStorageError(failure) && failure.providerCode === "APINotImplemented") {
    ctx.skip("The endpoint does not implement `Put Blob From URL` (ADR 0025)");
  }

  if (failure instanceof Error) throw failure;
}

/**
 * `size` bytes, one mebibyte at a time, each mebibyte filled with its index, so that the bytes
 * on either side of a block boundary show the blocks committed in order.
 */
function sourceStream(size: number): ReadableStream<Uint8Array> {
  let pulled = 0;

  return new ReadableStream({
    pull(controller) {
      if (pulled >= size) {
        controller.close();
        return;
      }

      const length = Math.min(mebibyte, size - pulled);

      controller.enqueue(new Uint8Array(length).fill(pulled / mebibyte));
      pulled += length;
    },
  });
}

describe.skipIf(underAccountKey === undefined || underAccessToken === undefined)(
  "adapter-azure-blob against the endpoint",
  () => {
    // The real account keeps what a run leaves for a day (ADR 0023), and a run leaves
    // nothing where it can help it.
    afterAll(async () => {
      await azureBlobStorage(endpointOrFail(underAccountKey)).deleteAll(prefix);
    });

    test("Shared Key signs a `put` of held bytes and a `get` the endpoint accepts", async () => {
      const storage = azureBlobStorage(endpointOrFail(underAccountKey));
      const body = new TextEncoder().encode("written under the account key");

      const written = await storage.put(encodedKey, body, { contentType: "text/plain" });
      const stored = await storage.get(encodedKey);

      expect(written.size).toBe(body.byteLength);
      expect(stored.stat.contentType).toBe("text/plain");
      expect(await stored.bytes()).toEqual(body);
    });

    test("what one scheme wrote, the other reads", async () => {
      const key = `${prefix}between-schemes`;

      await azureBlobStorage(endpointOrFail(underAccessToken)).put(key, "written under the token");

      const stored = await azureBlobStorage(endpointOrFail(underAccountKey)).get(key);

      expect(await stored.text()).toBe("written under the token");
    });

    test("Shared Key signs a `Put Blob` carrying user metadata named `a1` and `a_`", async () => {
      const storage = azureBlobStorage(endpointOrFail(underAccountKey));
      const key = `${encodedPrefix}user-metadata`;

      await storage.put(key, "carries user metadata", { userMetadata });

      expect((await storage.stat(key)).userMetadata).toEqual(userMetadata);
      expect((await storage.get(key)).stat.userMetadata).toEqual(userMetadata);
    });

    test(
      "Shared Key signs every block of a stream and the `Put Block List` carrying its user metadata",
      async () => {
        const storage = azureBlobStorage({
          ...endpointOrFail(underAccountKey),
          multipart: { partSize },
        });
        const key = `${encodedPrefix}streamed.bin`;
        const size = 2 * partSize + mebibyte;

        const written = await storage.put(key, sourceStream(size), {
          contentType: "application/x-stowage",
          userMetadata,
        });
        const stat = await storage.stat(key);
        const acrossBlocks = await storage.get(key, {
          range: { start: partSize - 1, end: partSize },
        });

        expect(written.size).toBe(size);
        expect(stat).toMatchObject({ size, contentType: "application/x-stowage", userMetadata });
        expect(await acrossBlocks.bytes()).toEqual(
          new Uint8Array([partSize / mebibyte - 1, partSize / mebibyte]),
        );
      },
      uploadTimeout,
    );

    test("Shared Key signs a `stat`, an `exists` and a ranged `get`", async () => {
      const storage = azureBlobStorage(endpointOrFail(underAccountKey));
      const key = `${encodedPrefix}described`;

      await storage.put(key, "0123456789", { contentType: "text/plain" });

      const stored = await storage.get(key, { range: { start: 2, end: 4 } });

      expect(await storage.stat(key)).toMatchObject({ key, size: 10, contentType: "text/plain" });
      expect(await storage.exists(key)).toBe(true);
      expect(await storage.exists(`${encodedPrefix}absent`)).toBe(false);
      expect(await stored.text()).toBe("234");
    });

    // `List Blobs` is the first request whose query Shared Key signs, and the prefix in it
    // travels encoded.
    test("Shared Key signs a listing below a prefix of characters that travel encoded", async () => {
      const storage = azureBlobStorage(endpointOrFail(underAccountKey));
      const listedPrefix = `${encodedPrefix}listed/`;
      const key = `${listedPrefix}one`;

      await storage.put(key, "listed under the account key");

      const page = await storage.list({ prefix: listedPrefix, delimiter: "/" }).page();

      expect(page.objects.map((entry) => entry.key)).toEqual([key]);
    });

    // A Blob Batch carries a Shared Key signature for every subrequest beside its own, each
    // over a path that travels encoded.
    test("Shared Key signs a Blob Batch and every subrequest inside it", async () => {
      const storage = azureBlobStorage(endpointOrFail(underAccountKey));
      const keys = [`${encodedPrefix}batched/one`, `${encodedPrefix}batched/二`];

      await Promise.all(keys.map(async (key) => await storage.put(key, "deleted in a batch")));

      const report = await storage.delete(...keys, `${encodedPrefix}batched/absent`);

      expect(report).toEqual({ requested: 3, failed: [] });
      expect(await Promise.all(keys.map(async (key) => await storage.exists(key)))).toEqual([
        false,
        false,
      ]);
    });

    test("Shared Key signs a `deleteAll`, its listing and its batch", async () => {
      const storage = azureBlobStorage(endpointOrFail(underAccountKey));
      const deletedPrefix = `${encodedPrefix}deleted-all/`;
      const keys = [`${deletedPrefix}one`, `${deletedPrefix}nested/二`];

      await Promise.all(keys.map(async (key) => await storage.put(key, "deleted below a prefix")));

      const report = await storage.deleteAll(deletedPrefix);
      const page = await storage.list({ prefix: deletedPrefix }).page();

      expect(report).toEqual({ requested: 2, failed: [] });
      expect(page.objects).toEqual([]);
    });

    test("Shared Key signs a copy whose source carries a service SAS", async (ctx) => {
      const storage = azureBlobStorage(endpointOrFail(underAccountKey));
      const from = `${encodedPrefix}copied/source`;
      const to = `${encodedPrefix}copied/destination`;

      await storage.put(from, "copied under the account key", {
        contentType: "text/plain",
        userMetadata,
      });

      skipWithoutPutBlobFromUrl(
        ctx,
        await storage.copy(from, to).catch((failure: unknown) => failure),
      );

      const stored = await storage.get(to);

      expect(stored.stat).toMatchObject({ contentType: "text/plain", userMetadata });
      expect(await stored.text()).toBe("copied under the account key");
    });

    test("Shared Key signs a move, a copy followed by a `Delete Blob`", async (ctx) => {
      const storage = azureBlobStorage(endpointOrFail(underAccountKey));
      const from = `${encodedPrefix}moved/source`;
      const to = `${encodedPrefix}moved/destination`;

      await storage.put(from, "moved under the account key");

      skipWithoutPutBlobFromUrl(
        ctx,
        await storage.move(from, to).catch((failure: unknown) => failure),
      );

      expect(await storage.exists(from)).toBe(false);
      expect(await (await storage.get(to)).text()).toBe("moved under the account key");
    });

    // ADR 0023: the presign cases run under the token, so the service SAS an account key
    // signs for `presignGet` is held against the endpoint here.
    test("under the account key `presignGet` is a service SAS the endpoint answers", async () => {
      const storage = azureBlobStorage(endpointOrFail(underAccountKey));
      const key = `${encodedPrefix}presigned`;

      await storage.put(key, "read through a service SAS", { contentType: "text/plain" });

      const response = await fetch(await storage.presignGet(key, { expiresIn: 300 }));

      expect(response.status).toBe(200);
      expect(await response.text()).toBe("read through a service SAS");
    });

    test("under the account key `presignPut` is refused with `InvalidCredentials`", async () => {
      const storage = azureBlobStorage(endpointOrFail(underAccountKey));
      const key = `${prefix}presign-put-under-account-key`;

      const failure = await storage
        .presignPut(key, { expiresIn: 300, contentType: "text/plain", contentLength: 1 })
        .catch((reason: unknown) => reason);

      expect(failure).toMatchObject({ code: "InvalidCredentials", attempts: 0 });
      expect(await storage.exists(key)).toBe(false);
    });
  },
);
