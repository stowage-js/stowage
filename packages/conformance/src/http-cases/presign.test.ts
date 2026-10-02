import type { ObjectStat, Storage } from "@stowage/core";
import { afterEach, expect, test, vi } from "vitest";

import type { HttpConformanceTarget } from "../http-target.ts";
import { createKeyPrefix, selectHalf, startRun } from "../run.ts";
import { stubStorage } from "../stubs.ts";
import { presignCases } from "./presign.ts";

/** One way of answering that departs from spec 10.6 and 14.8, which exactly one case is after. */
type Flaw =
  | "cached"
  | "text-answer"
  | "post-method"
  | "more-fields"
  | "no-headers"
  | "unsigned"
  | "get-presigned"
  | "other-allow"
  | "put-stored"
  | "no-max-size"
  | "string-length"
  | "line-feed"
  | "invalid-key-signed";

const provider = "http://provider.test";

interface Held {
  readonly bytes: Uint8Array;
  readonly contentType: string;
}

/** A storage reading what the provider holds, presigning an upload where `presigns` is set. */
function heldStorage(
  held: Map<string, Held>,
  fields: { readonly declares: boolean; readonly presigns: boolean },
): Storage {
  const storage = stubStorage({
    capabilities: fields.declares ? ["presignedUrls"] : [],
    exists: async (key) => held.has(key),
    stat: async (key): Promise<ObjectStat> => {
      const object = held.get(key);

      if (object === undefined) throw new Error(`The stub holds no ${key}`);

      return {
        key,
        size: object.bytes.byteLength,
        lastModified: new Date("2026-09-01T10:20:30.456Z"),
        etag: "e1",
        contentType: object.contentType,
        userMetadata: {},
      };
    },
  });

  return fields.presigns
    ? Object.assign(storage, {
        presignPut: async (key: string, options: { contentType: string }) => ({
          url: `${provider}/${encodeURIComponent(key)}?signed`,
          headers: { "content-type": options.contentType },
        }),
      })
    : storage;
}

/** Spec 10.6's checks of the client's values, short of what `flaw` lets through. */
function refusalOf(key: string, contentType: unknown, contentLength: unknown, flaw?: Flaw) {
  const length = flaw === "string-length" ? Number(contentLength) : contentLength;

  if (typeof length !== "number" || !Number.isInteger(length) || length < 0) return 400;
  if (length > 1048576 && flaw !== "no-max-size") return 413;
  if (typeof contentType !== "string" || contentType === "") return 400;
  if (contentType.includes("\n") && flaw !== "line-feed") return 400;
  if (key.endsWith("/") && flaw !== "invalid-key-signed") return 404;

  return undefined;
}

/** What spec 14.8 has a server answer for the `presign` route, short of what `flaw` breaks. */
async function answer(
  storage: Storage,
  held: Map<string, Held>,
  request: Request,
  flaw?: Flaw,
): Promise<Response> {
  const key = decodeURIComponent(new URL(request.url).pathname.slice("/presign/".length));

  if (request.method === "PUT" && flaw === "put-stored") {
    held.set(key, {
      bytes: new Uint8Array(await request.arrayBuffer()),
      contentType: "text/plain",
    });
  }

  const presigned =
    request.method === "POST" || (request.method === "GET" && flaw === "get-presigned");

  if (!presigned) {
    return new Response(null, {
      status: 405,
      headers: { allow: flaw === "other-allow" ? "GET, POST" : "POST" },
    });
  }

  const { contentType, contentLength } =
    request.method === "POST"
      ? // oxlint-disable-next-line no-unsafe-type-assertion -- what every case of this file sends
        ((await request.json()) as { contentType: unknown; contentLength: unknown })
      : { contentType: "text/plain", contentLength: 11 };
  const status = refusalOf(key, contentType, contentLength, flaw);

  if (status !== undefined) return new Response(null, { status });

  // oxlint-disable-next-line no-unsafe-type-assertion -- the storage presigns where it declares
  const { url, headers } = await (storage as Storage & { presignPut: PresignPut }).presignPut(key, {
    contentType: String(contentType),
  });

  return new Response(
    JSON.stringify({
      url: flaw === "unsigned" ? url.replace("?signed", "") : url,
      method: flaw === "post-method" ? "POST" : "PUT",
      ...(flaw === "no-headers" ? {} : { headers }),
      ...(flaw === "more-fields" ? { key } : {}),
    }),
    {
      status: 200,
      headers: {
        "content-type": flaw === "text-answer" ? "text/plain" : "application/json",
        "cache-control": flaw === "cached" ? "private, no-cache" : "private, no-store",
      },
    },
  );
}

type PresignPut = (
  key: string,
  options: { contentType: string },
) => Promise<{ url: string; headers: Record<string, string> }>;

/** The provider behind a presigned URL, storing a signed `PUT` with the type it carries. */
async function upload(held: Map<string, Held>, request: Request): Promise<Response> {
  const url = new URL(request.url);

  if (request.method !== "PUT" || !url.searchParams.has("signed")) {
    return new Response(null, { status: 403 });
  }

  held.set(decodeURIComponent(url.pathname.slice(1)), {
    bytes: new Uint8Array(await request.arrayBuffer()),
    contentType: request.headers.get("content-type") ?? "application/octet-stream",
  });

  return new Response(null, { status: 200 });
}

interface Server {
  readonly flaw?: Flaw;
  /** Whether the storage declares `presignedUrls`, which picks the half a case runs. */
  readonly declares?: boolean;
  /** Whether the storage carries `presignPut`, as it does where it declares. */
  readonly presigns?: boolean;
}

/** Runs one case against a server that answers as `answer` does, as `server` describes it. */
async function runAgainst(name: string, server: Server = {}): Promise<void> {
  const { flaw, declares = true, presigns = declares } = server;
  const held = new Map<string, Held>();
  const storage = heldStorage(held, { declares, presigns });
  const target: HttpConformanceTarget = {
    name: "reference",
    createStorage: () => storage,
    url: (route, key) => new URL(`http://server.test/${route}/${encodeURIComponent(key)}`),
  };
  const source = presignCases.find((each) => each.name === name);

  if (source === undefined) throw new Error(`The HTTP suite holds no case named ${name}`);

  vi.stubGlobal("fetch", async (url: URL | string, init?: RequestInit) => {
    const request = new Request(url, init);

    return request.url.startsWith(provider)
      ? await upload(held, request)
      : await answer(storage, held, request, flaw);
  });

  await selectHalf(source, await startRun(target, createKeyPrefix())).run();
}

afterEach(() => {
  vi.unstubAllGlobals();
});

test.each(presignCases.map((source) => source.name))(
  "`%s` passes against a server answering as spec 10.6 has it",
  async (name) => {
    await expect(runAgainst(name)).resolves.toBeUndefined();
  },
);

test.each(presignCases.map((source) => source.name))(
  "`%s` passes without `presignedUrls` where the storage carries no `presignPut`",
  async (name) => {
    await expect(runAgainst(name, { declares: false })).resolves.toBeUndefined();
  },
);

test.each(presignCases.map((source) => source.name))(
  "`%s` fails without `presignedUrls` where the storage carries `presignPut` all the same",
  async (name) => {
    await expect(runAgainst(name, { declares: false, presigns: true })).rejects.toThrow(
      "carries `presignPut`",
    );
  },
);

test.each<[string, Flaw, string]>([
  ["presign/put", "cached", "cache-control"],
  ["presign/put", "text-answer", "content-type"],
  ["presign/put", "post-method", 'and not "PUT"'],
  ["presign/put", "more-fields", "key beside"],
  ["presign/put", "no-headers", "no object of strings"],
  ["presign/put", "unsigned", "answers 403 and not 2xx"],
  ["presign/method-not-allowed", "get-presigned", "`GET` answers 200 and not 405"],
  ["presign/method-not-allowed", "other-allow", "allow"],
  ["presign/method-not-allowed", "put-stored", "holds an object"],
  ["presign/too-large", "no-max-size", "answers 200 and not 413"],
  ["presign/invalid-length", "string-length", '`contentLength` "11" answers 200 and not 400'],
  ["presign/invalid-content-type", "line-feed", "answers 200 and not 400"],
  ["presign/invalid-key", "invalid-key-signed", "answers 200 and not 404"],
])("`%s` fails against a server with the flaw %s", async (name, flaw, message) => {
  await expect(runAgainst(name, { flaw })).rejects.toThrow(message);
});
