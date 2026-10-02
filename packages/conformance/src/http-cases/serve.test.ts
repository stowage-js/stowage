import { type ObjectStat, type PutBody, type Storage, StorageError } from "@stowage/core";
import { afterEach, expect, test, vi } from "vitest";

import type { HttpConformanceTarget } from "../http-target.ts";
import { createKeyPrefix, selectHalf, startRun } from "../run.ts";
import { stubStorage } from "../stubs.ts";
import { httpConformanceCases } from "./index.ts";

/** One way of answering that departs from spec 10.3, which exactly one case is after. */
type Flaw =
  | "content-length"
  | "no-nosniff"
  | "unquoted-etag"
  | "raw-disposition"
  | "head-with-body"
  | "post-served"
  | "invalid-key-400"
  | "range-honored";

interface Held {
  readonly bytes: Uint8Array<ArrayBuffer>;
  readonly stat: ObjectStat;
}

const refuse = (key: string, code: "NotFound" | "InvalidKey"): StorageError =>
  new StorageError({
    code,
    message: code,
    operation: "get",
    bucket: "stub",
    provider: "stub",
    attempts: 1,
    key,
  });

function heldStorage(): Storage {
  const held = new Map<string, Held>();
  const read = (key: string): Held => {
    if (key.includes("//")) throw refuse(key, "InvalidKey");

    const found = held.get(key);

    if (found === undefined) throw refuse(key, "NotFound");

    return found;
  };

  return stubStorage({
    put: async (key: string, body: PutBody, options) => {
      if (body instanceof ReadableStream) throw new Error("The stub stores bytes alone");

      const bytes =
        typeof body === "string" ? new TextEncoder().encode(body) : new Uint8Array(body);

      const stat: ObjectStat = {
        key,
        size: bytes.byteLength,
        lastModified: new Date("2026-09-01T10:20:30.456Z"),
        etag: "e1",
        contentType: options?.contentType ?? "application/octet-stream",
        userMetadata: {},
      };

      held.set(key, { bytes, stat });

      return stat;
    },
    stat: async (key) => read(key).stat,
    get: async (key) => {
      const { bytes, stat } = read(key);

      return {
        stat,
        stream: () => new Response(bytes).body ?? new ReadableStream(),
        bytes: async () => bytes,
        text: async () => new TextDecoder().decode(bytes),
        json: async () => JSON.parse(new TextDecoder().decode(bytes)),
      };
    },
  });
}

/**
 * What spec 10.3 has a server answer for the `serve` route, short of what `flaw` breaks.
 * With `dateOf`, every answer carries a `Date` and caps `Last-Modified` at it, which a
 * server behind a provider whose clock runs ahead does.
 */
async function answer(
  storage: Storage,
  request: Request,
  flaw?: Flaw,
  dateOf?: () => Date,
): Promise<Response> {
  const key = decodeURIComponent(new URL(request.url).pathname.slice("/serve/".length));

  if (request.method !== "GET" && request.method !== "HEAD" && flaw !== "post-served") {
    return new Response(null, { status: 405, headers: { allow: "GET, HEAD" } });
  }

  let held: Held;

  try {
    const stat = await storage.stat(key);

    held = { stat, bytes: new Uint8Array(await (await storage.get(key)).bytes()) };
  } catch (thrown) {
    const invalid = thrown instanceof StorageError && thrown.code === "InvalidKey";

    return new Response(null, { status: invalid && flaw === "invalid-key-400" ? 400 : 404 });
  }

  const { stat, bytes } = held;
  const name = key.slice(key.lastIndexOf("/") + 1);
  const headers = new Headers({
    "content-type": stat.contentType,
    "x-content-type-options": "nosniff",
    "content-disposition":
      name === "résumé 100%.pdf" && flaw !== "raw-disposition"
        ? `attachment; filename="r_sum_ 100_.pdf"; filename*=UTF-8''r%C3%A9sum%C3%A9%20100%25.pdf`
        : `attachment; filename="${name}"`,
    "cache-control": "private, no-cache",
    etag: flaw === "unquoted-etag" ? "e1" : '"e1"',
    "last-modified": "Tue, 01 Sep 2026 10:20:30 GMT",
  });

  if (dateOf !== undefined) {
    const date = dateOf().toUTCString();

    headers.set("date", date);
    headers.set("last-modified", date);
  }

  if (flaw === "no-nosniff") headers.delete("x-content-type-options");
  if (flaw === "content-length") headers.set("content-length", String(bytes.byteLength));

  if (flaw === "range-honored" && request.headers.has("range")) {
    return new Response(bytes.subarray(0, 2), { status: 206, headers });
  }

  const sendsBody = request.method !== "HEAD" || flaw === "head-with-body";

  return new Response(sendsBody ? bytes : null, { status: 200, headers });
}

/** Runs one case against a server that answers as `answer` does with `flaw` and `dateOf`. */
async function runAgainst(name: string, flaw?: Flaw, dateOf?: () => Date): Promise<void> {
  const storage = heldStorage();
  const target: HttpConformanceTarget = {
    name: "reference",
    createStorage: () => storage,
    url: (route, key) => new URL(`http://server.test/${route}/${encodeURIComponent(key)}`),
  };
  const source = httpConformanceCases.find((each) => each.name === name);

  if (source === undefined) throw new Error(`The HTTP suite holds no case named ${name}`);

  vi.stubGlobal(
    "fetch",
    async (url: URL, init?: RequestInit) =>
      await answer(storage, new Request(url, init), flaw, dateOf),
  );

  await selectHalf(source, await startRun(target, createKeyPrefix())).run();
}

afterEach(() => {
  vi.unstubAllGlobals();
});

test.each(httpConformanceCases.map((source) => source.name))(
  "`%s` passes against a server answering as spec 10.3 has it",
  async (name) => {
    await expect(runAgainst(name)).resolves.toBeUndefined();
  },
);

test.each<[string, Flaw, string]>([
  ["serve/whole", "content-length", "carries `content-length"],
  ["serve/headers", "no-nosniff", "x-content-type-options"],
  ["serve/headers", "unquoted-etag", "etag"],
  ["serve/disposition", "raw-disposition", "content-disposition"],
  ["serve/head", "head-with-body", "answers with a body"],
  ["serve/head", "content-length", "content-length"],
  ["serve/not-found", "invalid-key-400", "`a//b` answers 400"],
  ["serve/method-not-allowed", "post-served", "`POST` answers 200"],
  ["serve/ignored-range", "range-honored", "answers 206"],
])("`%s` fails against a server with the flaw %s", async (name, flaw, message) => {
  await expect(runAgainst(name, flaw)).rejects.toThrow(message);
});

test("`serve/head` passes where each answer caps `Last-Modified` at its own `Date`", async () => {
  // Earlier than the stub's `lastModified`, a second further on for every answer.
  let answered = 0;
  const dateOf = (): Date => new Date(Date.UTC(2026, 8, 1, 10, 20, 20 + answered++));

  await expect(runAgainst("serve/head", undefined, dateOf)).resolves.toBeUndefined();
});
