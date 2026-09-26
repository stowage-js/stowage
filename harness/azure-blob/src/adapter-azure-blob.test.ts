import { describe, expect, test } from "vitest";

import { azureBlobStorage } from "../../../packages/adapter-azure-blob/src/index.ts";
import { isStorageError } from "../../../packages/core/src/index.ts";
import { configuredStorage, endpointOrFail, storageUnderAccountKey } from "./environment.ts";

// ADR 0023: the account key is promised as much as the access token, and the suite runs
// under the token alone, so Shared Key is held against the endpoint here. Without one
// these are skipped: `conformance.test.ts` already fails that run once, which is the
// failure ADR 0012 asks for.
const underAccountKey = storageUnderAccountKey();
const underAccessToken = configuredStorage();

const prefix = `stowage-harness/${crypto.randomUUID()}/`;

/** Characters a key may hold that travel encoded, each of which the signature covers. */
const encodedPrefix = `${prefix}a b#c?d%e+f'(g)*!/`;
const encodedKey = `${encodedPrefix}grüße/日本.txt`;

describe.skipIf(underAccountKey === undefined || underAccessToken === undefined)(
  "adapter-azure-blob against the endpoint",
  () => {
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

    // `List Blobs` is the first request whose query Shared Key signs, and the prefix in it
    // travels encoded.
    test("Shared Key signs a listing below a prefix of characters that travel encoded", async () => {
      const storage = azureBlobStorage(endpointOrFail(underAccountKey));
      const key = `${encodedPrefix}listed`;

      await storage.put(key, "listed under the account key");

      const page = await storage.list({ prefix: encodedPrefix, delimiter: "/" }).page();

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

    // ADR 0025: under the account key the source of a copy carries a service SAS, which an
    // endpoint checks only where it carries `Put Blob From URL`. The pinned Azurite answers
    // `501`, and the test copies once the pin moves to a release that does not.
    test("Shared Key signs a copy whose source carries a service SAS", async (ctx) => {
      const storage = azureBlobStorage(endpointOrFail(underAccountKey));
      const from = `${encodedPrefix}copied/source`;
      const to = `${encodedPrefix}copied/destination`;

      await storage.put(from, "copied under the account key", { contentType: "text/plain" });

      const copied = await storage.copy(from, to).catch((failure: unknown) => failure);

      if (isStorageError(copied) && copied.providerCode === "APINotImplemented") {
        ctx.skip("The endpoint does not implement `Put Blob From URL` (ADR 0025)");
      }

      if (copied instanceof Error) throw copied;

      const stored = await storage.get(to);

      expect(stored.stat.contentType).toBe("text/plain");
      expect(await stored.text()).toBe("copied under the account key");
    });
  },
);
