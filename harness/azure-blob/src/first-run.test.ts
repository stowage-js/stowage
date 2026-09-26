import { randomUUID } from "node:crypto";
import { env } from "node:process";

import { afterAll, describe, expect, test } from "vitest";

import {
  readConfiguration,
  type AzureBlobConfiguration,
} from "../../../packages/adapter-azure-blob/src/configuration.ts";
import { encodeCursor } from "../../../packages/adapter-azure-blob/src/cursor.ts";
import { azureBlobStorage } from "../../../packages/adapter-azure-blob/src/index.ts";
import { send } from "../../../packages/adapter-azure-blob/src/request.ts";
import { isStorageError, parseXml } from "../../../packages/core/src/index.ts";
import { firstRunSuite } from "../../s3/src/first-run.ts";
import { runOptionsFrom } from "../../targets/src/run-options.ts";
import { endpointNameFrom } from "./configuration.ts";
import type { AzureBlobRealEndpoint } from "./divergences.ts";
import { configuredStorage, endpointOrFail } from "./environment.ts";
import { azureProbeNames } from "./first-run.ts";

/* oxlint-disable vitest/valid-title -- the titles are the names the spec 13 report reads,
   kept once in `first-run.ts` for both */

// Spec 13 and spec 9.4: what only the account can answer, asked of it by the scheduled run
// under the access token the suite runs under. Azurite applies response overrides to any
// `GET`, carries no CORS rule and differs from the service where these probes look, so they
// run against the account alone. The requests go through the adapter's own signing and
// failure mapping wherever the adapter can send them.
const account: AzureBlobRealEndpoint = "azure-blob";

// One configuration for every probe, so that they share the token its resolver keeps.
const configured = configuredStorage();
const scheduled =
  runOptionsFrom(env).includeSlow === true &&
  endpointNameFrom(env) === account &&
  configured !== undefined;

/** The one origin the account's CORS rule allows (ADR 0023). */
const allowedOrigin = "https://conformance.stowage.invalid";

const mebibyte = 1024 * 1024;

/** The source `Put Blob From URL` takes, spec 8.7, and a mebibyte past it. */
const aboveTheCopyLimit = 5000 * mebibyte + mebibyte;

/** Parts the size of which keeps the upload of `aboveTheCopyLimit` at 79 blocks. */
const largePartSize = 64 * mebibyte;

const largeObjectTimeout = 40 * 60_000;

/** Past the second the expired URL signs for, as `presign/expired-url` waits it out. */
const pastTheLifetime = 2000;

const utf8 = new TextEncoder();

describe.skipIf(!scheduled)(firstRunSuite, () => {
  const prefix = `first-run-${randomUUID()}/`;

  afterAll(async () => {
    await storage().deleteAll(prefix);
  });

  test(azureProbeNames.responseOverrides, async () => {
    const key = `${prefix}overrides.txt`;
    const overrides = {
      "content-type": "application/x-stowage-override",
      "content-disposition": 'attachment; filename="override.txt"',
      "cache-control": "no-store",
    };

    await storage().put(key, "the body the overrides describe", { contentType: "text/plain" });

    const response = await fetch(
      await storage().presignGet(key, {
        expiresIn: 300,
        responseContentType: overrides["content-type"],
        responseContentDisposition: overrides["content-disposition"],
        responseCacheControl: overrides["cache-control"],
      }),
    );

    await response.arrayBuffer();

    // Each override beside the header it came back as, so that one ignored override reads
    // as a failure of its own rather than as a status that looked fine.
    expect({
      status: response.status,
      ...Object.fromEntries(
        Object.keys(overrides).map((name) => [name, response.headers.get(name)]),
      ),
    }).toEqual({ status: 200, ...overrides });
  });

  // Spec 8.5 repeats a `Put Block List` after a lost response, which holds only where the
  // same commit sent again succeeds and leaves the same object.
  test(azureProbeNames.commitTwice, async () => {
    const key = `${prefix}committed-twice.bin`;
    const blocks = [utf8.encode("first block, "), utf8.encode("second block")];
    const ids = [blockId(1), blockId(2)];

    await Promise.all(
      blocks.map(async (bytes, index) => await putBlock(key, ids[index] ?? "", bytes)),
    );

    const statuses = [await commit(key, ids), await commit(key, ids)];
    const stored = await storage().get(key);

    expect(statuses).toEqual([201, 201]);
    expect(await stored.text()).toBe("first block, second block");
  });

  // Spec 8.2 and 8.6: what a failed upload leaves goes with the next write to the name.
  test(azureProbeNames.putBlobDiscards, async () => {
    const key = `${prefix}discarded-blocks.bin`;

    await putBlock(key, blockId(1), utf8.encode("a block no commit names"));
    expect(await uncommittedBlocks(key)).toHaveLength(1);

    await storage().put(key, "written whole");

    expect(await uncommittedBlocks(key)).toEqual([]);
    expect(await (await storage().get(key)).text()).toBe("written whole");
  });

  // ADR 0023 settles the question ADR 0022 left: whether a page that uploads through an
  // expired URL reads the refusal's status, which it does only where the `403` carries the
  // CORS headers of the rule.
  test(azureProbeNames.expiredUrlCors, async ({ task }) => {
    const key = `${prefix}expired-put.txt`;
    const body = utf8.encode("an upload after the URL expired");
    const { url, headers } = await storage().presignPut(key, {
      expiresIn: 1,
      contentType: "text/plain",
      contentLength: body.byteLength,
    });
    const preflight = await fetch(url, {
      method: "OPTIONS",
      headers: {
        origin: allowedOrigin,
        "access-control-request-method": "PUT",
        "access-control-request-headers": Object.keys(headers).join(","),
      },
    });

    await preflight.arrayBuffer();
    expect({
      status: preflight.status,
      origin: preflight.headers.get("access-control-allow-origin"),
    }).toEqual({ status: 200, origin: allowedOrigin });

    await new Promise<void>((resolve) => void setTimeout(resolve, pastTheLifetime));

    const upload = await fetch(url, {
      method: "PUT",
      headers: { ...headers, origin: allowedOrigin },
      body,
    });

    await upload.arrayBuffer();

    task.meta.observed =
      `${upload.status} \`${upload.headers.get("x-ms-error-code") ?? ""}\`, ` +
      `\`access-control-allow-origin: ${upload.headers.get("access-control-allow-origin") ?? "(none)"}\``;

    expect({
      status: upload.status,
      origin: upload.headers.get("access-control-allow-origin"),
    }).toEqual({ status: 403, origin: allowedOrigin });
  });

  test(azureProbeNames.longNameOnHead, async () => {
    // Addressable above the 1,024 characters Azure holds, so the request goes out and the
    // answer is the service's.
    const key = `${prefix}${"a".repeat(1025 - prefix.length)}`;

    await expect(storage().stat(key)).rejects.toMatchObject({
      code: "InvalidKey",
      status: 400,
    });
    await expect(storage().exists(key)).rejects.toMatchObject({
      code: "InvalidKey",
      status: 400,
    });
  });

  // Spec 8.7: there is no fallback to blocks copied by range, so above the service's limit
  // `copy` rejects. Which code the `409` carries is what the run records. The limit is the
  // service's and no property of the Node line, so one line uploads the 5,000 MiB.
  test.skipIf(env["STOWAGE_AZURE_BLOB_COPY_ABOVE_LIMIT"] !== "true")(
    azureProbeNames.copyAboveLimit,
    async ({ task }) => {
      const large = azureBlobStorage({
        ...endpointOrFail(configured),
        multipart: { partSize: largePartSize },
      });
      const source = `${prefix}above-the-copy-limit.bin`;

      await large.put(source, zeroes(aboveTheCopyLimit));

      try {
        const copied = await large.copy(source, `${prefix}copied.bin`);

        expect(copied.size).toBe(aboveTheCopyLimit);
        task.meta.observed = `copied ${aboveTheCopyLimit} bytes in one request`;
      } catch (thrown) {
        if (!isStorageError(thrown) || thrown.code !== "InvalidRequest") throw thrown;

        task.meta.observed =
          `refused as \`${thrown.code}\`, ${thrown.status} \`${thrown.providerCode}\`: ` +
          thrown.message;
      }
    },
    largeObjectTimeout,
  );

  // A cursor of this adapter's own around a marker the service never handed out, which is
  // the nearest a run comes to one the service no longer continues from.
  // oxlint-disable-next-line vitest/expect-expect -- spec 13 records what the service answers, so any answer passes
  test(azureProbeNames.staleMarker, async ({ task }) => {
    await storage().put(`${prefix}listed/one`, "listed");

    const cursor = encodeCursor("2!96!c3Rvd2FnZS1maXJzdC1ydW4tc3RhbGUtbWFya2Vy!000028!");

    try {
      const page = await storage()
        .list({ prefix: `${prefix}listed/`, cursor })
        .page();

      task.meta.observed = `continued with ${page.objects.length} objects`;
    } catch (thrown) {
      if (!isStorageError(thrown)) throw thrown;

      task.meta.observed = `\`${thrown.code}\`, ${thrown.status} \`${thrown.providerCode}\``;
    }
  });

  // Spec 4.8 leaves it to the provider; one blob under both names means the service
  // normalizes, and two mean `keyBytesPreserved` can be declared.
  // oxlint-disable-next-line vitest/expect-expect -- spec 13 records what the service answers, so any answer passes
  test(azureProbeNames.unicodeEquivalentNames, async ({ task }) => {
    const below = `${prefix}unicode/`;
    // Built from code points, since an editor may save either form as the other.
    const nfc = `${below}caf${String.fromCodePoint(0xe9)}`;
    const nfd = `${below}cafe${String.fromCodePoint(0x301)}`;

    await storage().put(nfc, "written under NFC");
    await storage().put(nfd, "written under NFD");

    const listed = (await storage().list({ prefix: below }).page()).objects.map((entry) =>
      entry.key === nfc ? "NFC" : entry.key === nfd ? "NFD" : JSON.stringify(entry.key),
    );
    const readBack = [
      await (await storage().get(nfc)).text(),
      await (await storage().get(nfd)).text(),
    ];

    task.meta.observed = `listed as ${listed.join(" and ")}; read back as ${JSON.stringify(readBack)}`;
  });

  // Spec 8.1 refuses these before any request, so the probe sends each `Put Blob` itself and
  // reads what the service did with the name.
  // oxlint-disable-next-line vitest/expect-expect -- spec 13 records what the service answers, so any answer passes
  test(azureProbeNames.refusedWritableKeys, async ({ task }) => {
    const below = `${prefix}refused/`;
    const keys = {
      "255 segments": `${below}${"s/".repeat(254)}s`,
      "a segment ending in `.`": `${below}dotted./blob`,
      "U+0085": `${below}c1\u0085control`,
    };
    const answers = await Promise.all(
      Object.entries(keys).map(async ([kind, key]) => ({ kind, key, answer: await rawPut(key) })),
    );
    const { objects } = await storage().list({ prefix: below }).page();
    const listed = new Set(objects.map((entry) => entry.key));
    const written: readonly string[] = Object.values(keys);
    const unmatched = [...listed].filter((name) => !written.includes(name));
    const outcomes = answers.map(({ kind, key, answer }) => {
      if (answer !== undefined) return `${kind}: ${answer}`;

      return `${kind}: ${listed.has(key) ? "stored and listed as written" : "stored, not listed as written"}`;
    });

    task.meta.observed = [
      ...outcomes,
      ...(unmatched.length === 0 ? [] : [`listed besides: ${JSON.stringify(unmatched)}`]),
    ].join("; ");
  });

  function storage(): ReturnType<typeof azureBlobStorage> {
    return azureBlobStorage(endpointOrFail(configured));
  }

  function endpointConfiguration(): AzureBlobConfiguration {
    return readConfiguration(endpointOrFail(configured));
  }

  async function putBlock(key: string, id: string, bytes: Uint8Array<ArrayBuffer>): Promise<void> {
    const response = await send(endpointConfiguration(), {
      method: "PUT",
      operation: "put",
      key,
      query: [
        ["comp", "block"],
        ["blockid", id],
      ],
      body: bytes,
    });

    await response.body?.cancel();
  }

  async function commit(key: string, ids: readonly string[]): Promise<number> {
    const latest = ids.map((id) => `<Latest>${id}</Latest>`).join("");
    const response = await send(endpointConfiguration(), {
      method: "PUT",
      operation: "put",
      key,
      query: [["comp", "blocklist"]],
      headers: [["x-ms-blob-content-type", "application/octet-stream"]],
      body: utf8.encode(`<?xml version="1.0" encoding="utf-8"?><BlockList>${latest}</BlockList>`),
    });

    await response.body?.cancel();

    return response.status;
  }

  async function uncommittedBlocks(key: string): Promise<readonly string[]> {
    const response = await send(endpointConfiguration(), {
      method: "GET",
      operation: "get",
      key,
      query: [
        ["comp", "blocklist"],
        ["blocklisttype", "uncommitted"],
      ],
    });
    const list = parseXml(await response.text());
    const uncommitted = list.children.find((child) => child.name === "UncommittedBlocks");

    return (uncommitted?.children ?? []).map(
      (block) => block.children.find((child) => child.name === "Name")?.text ?? "",
    );
  }

  /** The refusal the service answered a `Put Blob` of the key with, or nothing where it took it. */
  async function rawPut(key: string): Promise<string | undefined> {
    try {
      const response = await send(endpointConfiguration(), {
        method: "PUT",
        operation: "put",
        key,
        headers: [
          ["content-type", "text/plain"],
          ["x-ms-blob-type", "BlockBlob"],
        ],
        body: utf8.encode("written past the refusal of spec 8.1"),
      });

      await response.body?.cancel();

      return undefined;
    } catch (thrown) {
      if (!isStorageError(thrown)) throw thrown;

      return `refused, ${thrown.status} \`${thrown.providerCode}\``;
    }
  }
});

/** Block ids of one length, as the service requires of the ids of one blob (ADR 0024). */
function blockId(index: number): string {
  return btoa(`first-run-${String(index).padStart(4, "0")}`);
}

function zeroes(size: number): ReadableStream<Uint8Array> {
  let pulled = 0;

  return new ReadableStream({
    pull(controller) {
      if (pulled >= size) return controller.close();

      const chunk = Math.min(mebibyte, size - pulled);

      controller.enqueue(new Uint8Array(chunk));
      pulled += chunk;
    },
  });
}
