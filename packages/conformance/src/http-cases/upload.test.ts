import type { ObjectStat, PutBody, Storage } from "@stowage/core";
import { afterEach, expect, test, vi } from "vitest";

import type { HttpConformanceTarget } from "../http-target.ts";
import { createKeyPrefix, selectHalf, startRun } from "../run.ts";
import { stubStorage } from "../stubs.ts";
import { uploadCases } from "./upload.ts";

/** One way of answering that departs from spec 10.5, which exactly one case is after. */
type Flaw =
  | "unquoted-etag"
  | "invented-etag"
  | "with-body"
  | "content-type-dropped"
  | "truncated-stream"
  | "text-default"
  | "empty-refused"
  | "first-write-wins"
  | "no-limit"
  | "unbounded-stream"
  | "partial-on-limit"
  | "coded-stored"
  | "coded-refused-and-stored"
  | "post-stored"
  | "other-allow"
  | "invalid-key-400"
  | "header-metadata";

interface Held {
  readonly bytes: Uint8Array<ArrayBuffer>;
  readonly contentType: string;
  readonly userMetadata: Record<string, string>;
}

const maxSize = 1048576;

/** A storage reading what the server holds, with an `etag` where `etags` is set. */
function heldStorage(held: Map<string, Held>, etags: boolean): Storage {
  const statOf = (key: string): ObjectStat => {
    const object = held.get(key);

    if (object === undefined) throw new Error(`The stub holds no ${key}`);

    return {
      key,
      size: object.bytes.byteLength,
      lastModified: new Date("2026-09-01T10:20:30.456Z"),
      etag: etags ? "e1" : undefined,
      contentType: object.contentType,
      userMetadata: object.userMetadata,
    };
  };

  return stubStorage({
    put: async (key: string, body: PutBody, options) => {
      if (!(body instanceof Uint8Array)) throw new Error("The stub stores bytes alone");

      held.set(key, {
        bytes: new Uint8Array(body),
        contentType: options?.contentType ?? "application/octet-stream",
        userMetadata: {},
      });

      return statOf(key);
    },
    stat: async (key) => statOf(key),
    exists: async (key) => held.has(key),
    get: async (key) => {
      const { bytes } = held.get(key) ?? { bytes: new Uint8Array() };

      return {
        stat: statOf(key),
        stream: () => new Response(bytes).body ?? new ReadableStream(),
        bytes: async () => bytes,
        text: async () => new TextDecoder().decode(bytes),
        json: async () => JSON.parse(new TextDecoder().decode(bytes)),
      };
    },
  });
}

interface Server {
  readonly flaw?: Flaw;
  /** Whether the storage hands over an `etag`, which `adapter-fs` does not. */
  readonly etags?: boolean;
}

/**
 * What spec 10.5 has a server answer for the `upload` route, short of what `flaw` breaks.
 * `streamed` tells a body `fetch` sends without a length, which the `Request` built from
 * its init does not show.
 */
async function answer(
  held: Map<string, Held>,
  request: Request,
  streamed: boolean,
  { flaw, etags = true }: Server,
): Promise<Response> {
  const key = decodeURIComponent(new URL(request.url).pathname.slice("/upload/".length));
  const accepted =
    request.method === "PUT" || (request.method === "POST" && flaw === "post-stored");

  if (!accepted) {
    return new Response(null, {
      status: 405,
      headers: { allow: flaw === "other-allow" ? "PUT, POST" : "PUT" },
    });
  }

  if (key.endsWith("/"))
    return new Response(null, { status: flaw === "invalid-key-400" ? 400 : 404 });

  const bytes = new Uint8Array(await request.arrayBuffer());
  const coded = request.headers.has("content-encoding");
  const stored: Held = {
    bytes: flaw === "truncated-stream" && streamed ? bytes.slice(0, 1024) : bytes,
    contentType:
      flaw === "content-type-dropped"
        ? "application/octet-stream"
        : (request.headers.get("content-type") ??
          (flaw === "text-default" ? "text/plain" : "application/octet-stream")),
    userMetadata:
      flaw === "header-metadata" ? { a: request.headers.get("x-amz-meta-a") ?? "" } : {},
  };

  if (coded && flaw !== "coded-stored") {
    if (flaw === "coded-refused-and-stored") held.set(key, stored);

    return new Response(null, { status: 415 });
  }

  const bounded = flaw !== "no-limit" && (flaw !== "unbounded-stream" || !streamed);

  if (bounded && bytes.byteLength > maxSize) {
    if (flaw === "partial-on-limit") held.set(key, { ...stored, bytes: bytes.slice(0, maxSize) });

    return new Response(null, { status: 413 });
  }

  if (bytes.byteLength === 0 && flaw === "empty-refused")
    return new Response(null, { status: 400 });
  if (!(flaw === "first-write-wins" && held.has(key))) held.set(key, stored);

  const tagged = etags || flaw === "invented-etag";

  return new Response(flaw === "with-body" ? "Created" : null, {
    status: 201,
    headers: tagged ? { etag: flaw === "unquoted-etag" ? "e1" : '"e1"' } : {},
  });
}

/** Runs one case against a server that answers as `answer` does, as `server` describes it. */
async function runAgainst(name: string, server: Server = {}): Promise<void> {
  const held = new Map<string, Held>();
  const storage = heldStorage(held, server.etags ?? true);
  const target: HttpConformanceTarget = {
    name: "reference",
    createStorage: () => storage,
    url: (route, key) => new URL(`http://server.test/${route}/${encodeURIComponent(key)}`),
  };
  const source = uploadCases.find((each) => each.name === name);

  if (source === undefined) throw new Error(`The HTTP suite holds no case named ${name}`);

  vi.stubGlobal(
    "fetch",
    async (url: URL | string, init?: RequestInit) =>
      await answer(held, new Request(url, init), init?.body instanceof ReadableStream, server),
  );

  await selectHalf(source, await startRun(target, createKeyPrefix())).run();
}

afterEach(() => {
  vi.unstubAllGlobals();
});

test.each(uploadCases.map((source) => source.name))(
  "`%s` passes against a server answering as spec 10.5 has it",
  async (name) => {
    await expect(runAgainst(name)).resolves.toBeUndefined();
  },
);

test.each(uploadCases.map((source) => source.name))(
  "`%s` passes against a storage that hands over no `etag`",
  async (name) => {
    await expect(runAgainst(name, { etags: false })).resolves.toBeUndefined();
  },
);

test.each<[string, Server, string]>([
  ["upload/stores", { flaw: "unquoted-etag" }, '`etag: "e1"`'],
  ["upload/stores", { flaw: "invented-etag", etags: false }, "and not null"],
  ["upload/stores", { flaw: "with-body" }, "answers with a body"],
  ["upload/stores", { flaw: "content-type-dropped" }, "the content type"],
  ["upload/streamed-body", { flaw: "truncated-stream" }, "The object the streamed `PUT` stored"],
  ["upload/content-type-default", { flaw: "text-default" }, '"text/plain"'],
  ["upload/empty-body", { flaw: "empty-refused" }, "answers 400 and not 201"],
  ["upload/overwrites", { flaw: "first-write-wins" }, "The object after the second `PUT`"],
  ["upload/max-size", { flaw: "no-limit" }, "answers 201 and not 413"],
  ["upload/max-size", { flaw: "unbounded-stream" }, "without a length answers 201 and not 413"],
  ["upload/max-size", { flaw: "partial-on-limit" }, "The object after the refused `PUT`s"],
  ["upload/content-encoding", { flaw: "coded-stored" }, "answers 201 and not 415"],
  ["upload/content-encoding", { flaw: "coded-refused-and-stored" }, "holds an object"],
  ["upload/method-not-allowed", { flaw: "post-stored" }, "`POST` answers 201 and not 405"],
  ["upload/method-not-allowed", { flaw: "other-allow" }, "allow"],
  ["upload/invalid-key", { flaw: "invalid-key-400" }, "answers 400 and not 404"],
  ["upload/no-header-metadata", { flaw: "header-metadata" }, "user metadata"],
])("`%s` fails against a server with the flaw %o", async (name, server, message) => {
  await expect(runAgainst(name, server)).rejects.toThrow(message);
});
