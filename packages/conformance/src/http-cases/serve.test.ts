import {
  type ContentHeaders,
  type ObjectStat,
  type PutBody,
  type Storage,
  StorageError,
} from "@stowage/core";
import { afterEach, expect, test, vi } from "vitest";

import type { HttpConformanceTarget } from "../http-target.ts";
import { createKeyPrefix, selectHalf, startRun } from "../run.ts";
import { stubStorage } from "../stubs.ts";
import { serveCases } from "./serve.ts";

/** One way of answering that departs from spec 10.3, which exactly one case is after. */
type Flaw =
  | "no-length"
  | "no-nosniff"
  | "unquoted-etag"
  | "raw-disposition"
  | "head-with-body"
  | "post-served"
  | "invalid-key-400"
  | "range-honored"
  | "range-without-length"
  | "range-undeclared"
  | "suffix-from-start"
  | "unsatisfiable-whole"
  | "strong-none-match"
  | "modified-since-beside-none-match"
  | "weak-match"
  | "unmodified-since-beside-match"
  | "if-range-date"
  | "no-language-on-304"
  | "stored-disposition-ignored"
  | "stored-inline-served"
  | "stored-cache-control-served";

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

function heldStorage(capabilities: readonly string[], etag: string | undefined): Storage {
  const held = new Map<string, Held>();
  const read = (key: string): Held => {
    if (key.includes("//")) throw refuse(key, "InvalidKey");

    const found = held.get(key);

    if (found === undefined) throw refuse(key, "NotFound");

    return found;
  };

  return stubStorage({
    capabilities,
    put: async (key: string, body: PutBody, options) => {
      if (body instanceof ReadableStream) throw new Error("The stub stores bytes alone");

      const bytes =
        typeof body === "string" ? new TextEncoder().encode(body) : new Uint8Array(body);
      const contentHeaders = contentHeadersOf(options ?? {});

      if (Object.keys(contentHeaders).length > 0 && !capabilities.includes("contentHeaders")) {
        throw new Error("The stub stores the content headers only where it declares them");
      }

      const stat: ObjectStat = {
        key,
        size: bytes.byteLength,
        lastModified: new Date("2026-09-01T10:20:30.456Z"),
        etag,
        contentType: options?.contentType ?? "application/octet-stream",
        userMetadata: {},
        ...contentHeaders,
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

function contentHeadersOf(options: ContentHeaders): ContentHeaders {
  return Object.fromEntries(
    (["cacheControl", "contentDisposition", "contentLanguage"] as const).flatMap((name) =>
      options[name] === undefined ? [] : [[name, options[name]]],
    ),
  );
}

/** Whether a stored `Content-Disposition` is one spec 10.3 sends, short of `flaw`. */
function servesStoredDisposition(stored: string | undefined, flaw?: Flaw): stored is string {
  if (stored === undefined || flaw === "stored-disposition-ignored") return false;

  return flaw === "stored-inline-served" || /^\s*attachment\s*(;|$)/iu.test(stored);
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
    "content-disposition": servesStoredDisposition(stat.contentDisposition, flaw)
      ? stat.contentDisposition
      : name === "résumé 100%.pdf" && flaw !== "raw-disposition"
        ? `attachment; filename="r_sum_ 100_.pdf"; filename*=UTF-8''r%C3%A9sum%C3%A9%20100%25.pdf`
        : `attachment; filename="${name}"; filename*=UTF-8''${encodeURIComponent(name)}`,
    "cache-control":
      flaw === "stored-cache-control-served"
        ? (stat.cacheControl ?? "private, no-cache")
        : "private, no-cache",
    "last-modified": "Tue, 01 Sep 2026 10:20:30 GMT",
  });

  if (stat.contentLanguage !== undefined) headers.set("content-language", stat.contentLanguage);

  if (stat.etag !== undefined) {
    headers.set("etag", flaw === "unquoted-etag" ? stat.etag : `"${stat.etag}"`);
  }

  if (dateOf !== undefined) {
    const date = dateOf().toUTCString();

    headers.set("date", date);
    headers.set("last-modified", date);
  }

  const refused = refusalOf(request.headers, stat, flaw);

  if (refused === 304) {
    if (flaw === "no-language-on-304") headers.delete("content-language");

    return new Response(null, { status: 304, headers });
  }
  if (refused === 412) return new Response(null, { status: 412 });

  if (flaw === "no-nosniff") headers.delete("x-content-type-options");

  if (flaw === "range-honored" && request.headers.has("range")) {
    return new Response(bytes.subarray(0, 2), { status: 206, headers });
  }

  const honorsRanges = storage.capabilities.includes("rangeReads") || flaw === "range-undeclared";

  if (honorsRanges) headers.set("accept-ranges", "bytes");

  const range =
    honorsRanges && request.method === "GET" && ifRangeHolds(request.headers, stat, flaw)
      ? rangeOf(request.headers.get("range"), bytes.byteLength, flaw)
      : undefined;

  if (range === "unsatisfiable") {
    return new Response(null, {
      status: 416,
      headers: { "content-range": `bytes */${bytes.byteLength}` },
    });
  }

  if (range !== undefined) {
    const [start, last] = range;

    headers.set("content-range", `bytes ${start}-${last}/${bytes.byteLength}`);

    if (flaw !== "range-without-length") headers.set("content-length", String(last - start + 1));

    return new Response(bytes.subarray(start, last + 1), { status: 206, headers });
  }

  // Spec 10.3: a `304` carries no `Content-Length`, the `200` and its `HEAD` the size.
  if (flaw !== "no-length") headers.set("content-length", String(bytes.byteLength));

  const sendsBody = request.method !== "HEAD" || flaw === "head-with-body";

  return new Response(sendsBody ? bytes : null, { status: 200, headers });
}

/** The tags of a field, each as it is written, `W/` included. */
const tagsOf = (field: string): string[] => field.split(",").map((tag) => tag.trim());

const secondOf = (time: number): number => Math.floor(time / 1000) * 1000;

/** The `304` or `412` of RFC 9110 13.2.2 for a precondition that fails, short of `flaw`. */
function refusalOf(headers: Headers, stat: ObjectStat, flaw?: Flaw): 304 | 412 | undefined {
  const etag = stat.etag === undefined ? undefined : `"${stat.etag}"`;
  const modified = secondOf(stat.lastModified.getTime());
  const ifMatch = headers.get("if-match");
  const ifUnmodifiedSince = headers.get("if-unmodified-since");
  const ifNoneMatch = headers.get("if-none-match");
  const ifModifiedSince = headers.get("if-modified-since");

  if (ifMatch !== null) {
    const tags = tagsOf(ifMatch).map((tag) =>
      flaw === "weak-match" ? tag.replace(/^W\//u, "") : tag,
    );

    if (ifMatch !== "*" && (etag === undefined || !tags.includes(etag))) return 412;
  }

  if (
    ifUnmodifiedSince !== null &&
    (ifMatch === null || flaw === "unmodified-since-beside-match") &&
    modified > Date.parse(ifUnmodifiedSince)
  ) {
    return 412;
  }

  if (ifNoneMatch !== null) {
    const tags = tagsOf(ifNoneMatch).map((tag) =>
      flaw === "strong-none-match" ? tag : tag.replace(/^W\//u, ""),
    );

    if (ifNoneMatch === "*" || (etag !== undefined && tags.includes(etag))) return 304;
  }

  if (
    ifModifiedSince !== null &&
    (ifNoneMatch === null || flaw === "modified-since-beside-none-match") &&
    modified <= Date.parse(ifModifiedSince)
  ) {
    return 304;
  }

  return undefined;
}

/** Whether `If-Range` lets the range through: the strong `ETag` alone does. */
function ifRangeHolds(headers: Headers, stat: ObjectStat, flaw?: Flaw): boolean {
  const ifRange = headers.get("if-range");

  if (ifRange === null) return true;
  if (flaw === "if-range-date" && !ifRange.startsWith('"')) {
    return secondOf(stat.lastModified.getTime()) <= Date.parse(ifRange);
  }

  return stat.etag !== undefined && ifRange === `"${stat.etag}"`;
}

/**
 * The first and last byte of the one range spec 10.3 honors, `"unsatisfiable"` for one
 * starting beyond the object, `undefined` for a `Range` it ignores.
 */
function rangeOf(
  field: string | null,
  size: number,
  flaw?: Flaw,
): readonly [number, number] | "unsatisfiable" | undefined {
  const [, first = "", last = ""] = /^bytes=(\d*)-(\d*)$/u.exec(field ?? "") ?? [];

  if (first === "" && last === "") return undefined;

  if (first === "") {
    const length = Number(last);

    return flaw === "suffix-from-start" ? [0, length - 1] : [Math.max(0, size - length), size - 1];
  }

  const start = Number(first);

  if (start >= size) return flaw === "unsatisfiable-whole" ? undefined : "unsatisfiable";

  return [start, Math.min(last === "" ? size - 1 : Number(last), size - 1)];
}

interface Server {
  readonly flaw?: Flaw;
  readonly dateOf?: () => Date;
  readonly capabilities?: readonly string[];
  /** The `etag` the storage hands over, none for `undefined`, as `adapter-fs` does. */
  readonly etag?: string | undefined;
}

/** Runs one case against a server that answers as `answer` does, as `server` describes it. */
async function runAgainst(name: string, server: Server = {}): Promise<void> {
  const { flaw, dateOf, capabilities = [] } = server;
  const storage = heldStorage(capabilities, "etag" in server ? server.etag : "e1");
  const target: HttpConformanceTarget = {
    name: "reference",
    createStorage: () => storage,
    url: (route, key) => new URL(`http://server.test/${route}/${encodeURIComponent(key)}`),
  };
  const source = serveCases.find((each) => each.name === name);

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

test.each(serveCases.map((source) => source.name))(
  "`%s` passes against a server answering as spec 10.3 has it",
  async (name) => {
    await expect(runAgainst(name)).resolves.toBeUndefined();
    await expect(runAgainst(name, { capabilities: ["rangeReads"] })).resolves.toBeUndefined();
    await expect(runAgainst(name, { capabilities: ["contentHeaders"] })).resolves.toBeUndefined();
  },
);

test.each(serveCases.map((source) => source.name))(
  "`%s` passes against such a server behind a storage handing over no `etag`",
  async (name) => {
    await expect(runAgainst(name, { etag: undefined })).resolves.toBeUndefined();
    await expect(
      runAgainst(name, { etag: undefined, capabilities: ["rangeReads"] }),
    ).resolves.toBeUndefined();
  },
);

test.each<[string, Flaw, string]>([
  ["serve/whole", "no-length", "content-length"],
  ["serve/headers", "no-nosniff", "x-content-type-options"],
  ["serve/headers", "unquoted-etag", "etag"],
  ["serve/disposition", "raw-disposition", "content-disposition"],
  ["serve/head", "head-with-body", "answers with a body"],
  ["serve/head", "no-length", "content-length"],
  ["serve/not-found", "invalid-key-400", "`a//b` answers 400"],
  ["serve/method-not-allowed", "post-served", "`POST` answers 200"],
  ["serve/ignored-range", "range-honored", "answers 206"],
  ["serve/if-none-match", "strong-none-match", "answers 200 and not 304"],
  ["serve/if-modified-since", "modified-since-beside-none-match", "answers 304 and not 200"],
  ["serve/if-match", "weak-match", "answers 200 and not 412"],
  ["serve/if-unmodified-since", "unmodified-since-beside-match", "answers 412 and not 200"],
])("`%s` fails against a server with the flaw %s", async (name, flaw, message) => {
  await expect(runAgainst(name, { flaw })).rejects.toThrow(message);
});

test.each<[string, Flaw, string]>([
  ["serve/range", "range-without-length", "content-length"],
  ["serve/suffix-range", "suffix-from-start", "The body of the `GET` with `Range: bytes=-3`"],
  ["serve/unsatisfiable-range", "unsatisfiable-whole", "answers 200 and not 416"],
  ["serve/if-range", "if-range-date", "answers 206 and not 200"],
])(
  "`%s` fails against a server with the flaw %s behind a storage declaring `rangeReads`",
  async (name, flaw, message) => {
    await expect(runAgainst(name, { flaw, capabilities: ["rangeReads"] })).rejects.toThrow(message);
  },
);

test.each<[string, Flaw, string]>([
  ["serve/content-language", "no-language-on-304", "content-language"],
  ["serve/stored-disposition", "stored-disposition-ignored", "stored.pdf"],
  ["serve/stored-disposition", "stored-inline-served", "inline"],
  ["serve/stored-cache-control", "stored-cache-control-served", "public, max-age=60"],
])(
  "`%s` fails against a server with the flaw %s behind a storage declaring `contentHeaders`",
  async (name, flaw, message) => {
    await expect(runAgainst(name, { flaw, capabilities: ["contentHeaders"] })).rejects.toThrow(
      message,
    );
  },
);

test.each(["serve/range", "serve/suffix-range", "serve/unsatisfiable-range"])(
  "`%s` fails where the server honors a range its storage does not declare",
  async (name) => {
    await expect(runAgainst(name, { flaw: "range-undeclared" })).rejects.toThrow("and not 200");
  },
);

test("`serve/head` passes where each answer caps `Last-Modified` at its own `Date`", async () => {
  // Earlier than the stub's `lastModified`, a second further on for every answer.
  let answered = 0;
  const dateOf = (): Date => new Date(Date.UTC(2026, 8, 1, 10, 20, 20 + answered++));

  await expect(runAgainst("serve/head", { dateOf })).resolves.toBeUndefined();
});
