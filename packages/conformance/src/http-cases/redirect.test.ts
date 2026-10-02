import type { ObjectStat, PutBody, Storage } from "@stowage/core";
import { afterEach, expect, test, vi } from "vitest";

import type { HttpConformanceTarget } from "../http-target.ts";
import { createKeyPrefix, selectHalf, startRun } from "../run.ts";
import { stubStorage } from "../stubs.ts";
import { redirectCases } from "./redirect.ts";

/** One way of answering that departs from spec 10.4, which exactly one case is after. */
type Flaw =
  | "cached"
  | "relative-location"
  | "with-body"
  | "other-object"
  | "head-refused"
  | "post-redirected";

const provider = "http://provider.test";

/** A storage holding what is put into it, presigning a download where `presigns` is set. */
function heldStorage(
  held: Map<string, Uint8Array<ArrayBuffer>>,
  fields: { readonly declares: boolean; readonly presigns: boolean },
): Storage {
  const storage = stubStorage({
    capabilities: fields.declares ? ["presignedUrls"] : [],
    put: async (key: string, body: PutBody): Promise<ObjectStat> => {
      if (typeof body !== "string" && !(body instanceof Uint8Array)) {
        throw new Error("The stub stores bytes and text alone");
      }

      const bytes = typeof body === "string" ? new TextEncoder().encode(body) : body.slice();

      held.set(key, bytes);

      return {
        key,
        size: bytes.byteLength,
        lastModified: new Date("2026-09-01T10:20:30.456Z"),
        etag: "e1",
        contentType: "text/plain",
        userMetadata: {},
      };
    },
  });

  return fields.presigns
    ? Object.assign(storage, {
        presignGet: async (key: string) => `${provider}/${encodeURIComponent(key)}?signed`,
      })
    : storage;
}

/** What spec 10.4 has a server answer for the `redirect` route, short of what `flaw` breaks. */
function answer(request: Request, flaw?: Flaw): Response {
  const { pathname } = new URL(request.url);
  const key = decodeURIComponent(pathname.slice("/redirect/".length));
  const redirected =
    request.method === "GET" ||
    (request.method === "HEAD" && flaw !== "head-refused") ||
    (request.method === "POST" && flaw === "post-redirected");

  if (!redirected) return new Response(null, { status: 405, headers: { allow: "GET, HEAD" } });

  const signed = `/${encodeURIComponent(flaw === "other-object" ? `${key}-other` : key)}?signed`;

  return new Response(flaw === "with-body" ? "Found" : null, {
    status: 302,
    headers: {
      location: flaw === "relative-location" ? signed : `${provider}${signed}`,
      "cache-control": flaw === "cached" ? "private, no-cache" : "private, no-store",
    },
  });
}

/** The provider behind a presigned URL, answering `GET` with the bytes the key holds. */
function download(held: Map<string, Uint8Array<ArrayBuffer>>, request: Request): Response {
  const key = decodeURIComponent(new URL(request.url).pathname.slice(1));
  const bytes = held.get(key) ?? new TextEncoder().encode("another object");

  return new Response(bytes, { status: 200 });
}

interface Server {
  readonly flaw?: Flaw;
  /** Whether the storage declares `presignedUrls`, which picks the half a case runs. */
  readonly declares?: boolean;
  /** Whether the storage carries `presignGet`, as it does where it declares. */
  readonly presigns?: boolean;
}

/** Runs one case against a server that answers as `answer` does, as `server` describes it. */
async function runAgainst(name: string, server: Server = {}): Promise<void> {
  const { flaw, declares = true, presigns = declares } = server;
  const held = new Map<string, Uint8Array<ArrayBuffer>>();
  const storage = heldStorage(held, { declares, presigns });
  const target: HttpConformanceTarget = {
    name: "reference",
    createStorage: () => storage,
    url: (route, key) => new URL(`http://server.test/${route}/${encodeURIComponent(key)}`),
  };
  const source = redirectCases.find((each) => each.name === name);

  if (source === undefined) throw new Error(`The HTTP suite holds no case named ${name}`);

  vi.stubGlobal("fetch", async (url: URL | string, init?: RequestInit) => {
    const request = new Request(url, init);

    return request.url.startsWith(provider) ? download(held, request) : answer(request, flaw);
  });

  await selectHalf(source, await startRun(target, createKeyPrefix())).run();
}

afterEach(() => {
  vi.unstubAllGlobals();
});

test.each(redirectCases.map((source) => source.name))(
  "`%s` passes against a server answering as spec 10.4 has it",
  async (name) => {
    await expect(runAgainst(name)).resolves.toBeUndefined();
  },
);

test.each(redirectCases.map((source) => source.name))(
  "`%s` passes without `presignedUrls` where the storage carries no `presignGet`",
  async (name) => {
    await expect(runAgainst(name, { declares: false })).resolves.toBeUndefined();
  },
);

test.each(redirectCases.map((source) => source.name))(
  "`%s` fails without `presignedUrls` where the storage carries `presignGet` all the same",
  async (name) => {
    await expect(runAgainst(name, { declares: false, presigns: true })).rejects.toThrow(
      "carries `presignGet`",
    );
  },
);

test.each<[string, Flaw, string]>([
  ["redirect/found", "cached", "cache-control"],
  ["redirect/found", "relative-location", "no absolute URL"],
  ["redirect/found", "with-body", "answers with a body"],
  ["redirect/found", "other-object", "The body of the `GET` on `Location`"],
  ["redirect/head", "relative-location", "no absolute URL"],
  ["redirect/head", "head-refused", "answers 405 and not 302"],
  ["redirect/method-not-allowed", "post-redirected", "answers 302 and not 405"],
])("`%s` fails against a server with the flaw %s", async (name, flaw, message) => {
  await expect(runAgainst(name, { flaw })).rejects.toThrow(message);
});
