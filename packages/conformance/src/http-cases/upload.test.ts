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
  | "reset-stream"
  | "stored-on-reset"
  | "coded-stored"
  | "coded-refused-and-stored"
  | "post-stored"
  | "other-allow"
  | "invalid-key-400"
  | "header-metadata"
  | "absent-ignored"
  | "unsupported-stored"
  | "if-match-201"
  | "weak-matches"
  | "free-key-written"
  | "if-match-wins"
  | "star-held"
  | "unmodified-since-ignored"
  | "malformed-ignored"
  | "malformed-after-501"
  | "if-modified-since-evaluated"
  | "if-range-501";

interface Held {
  readonly bytes: Uint8Array<ArrayBuffer>;
  readonly etag: string;
  readonly contentType: string;
  readonly userMetadata: Record<string, string>;
}

const maxSize = 1048576;

/** The writes of the run so far, which name the `etag` of each object written: `e1`, `e2`… */
let writes = 0;

const nextEtag = (): string => `e${++writes}`;

/**
 * A storage reading what the server holds, with an `etag` where `etags` is set, and
 * declaring `capabilities`.
 */
function heldStorage(
  held: Map<string, Held>,
  etags: boolean,
  capabilities: readonly string[],
): Storage {
  const statOf = (key: string): ObjectStat => {
    const object = held.get(key);

    if (object === undefined) throw new Error(`The stub holds no ${key}`);

    return {
      key,
      size: object.bytes.byteLength,
      lastModified: new Date("2026-09-01T10:20:30.456Z"),
      etag: etags ? object.etag : undefined,
      contentType: object.contentType,
      userMetadata: object.userMetadata,
    };
  };

  return stubStorage({
    capabilities,
    put: async (key: string, body: PutBody, options) => {
      if (!(body instanceof Uint8Array)) throw new Error("The stub stores bytes alone");

      held.set(key, {
        bytes: new Uint8Array(body),
        etag: nextEtag(),
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
  /**
   * What the storage declares: both write capabilities, or `writeIfAbsent` alone where it
   * hands over no `etag`, as `adapter-fs` does, where it is left out.
   */
  readonly declares?: readonly string[];
  /**
   * Where the connection is reset instead of answered: under a body sent with its length past
   * `maxSize`, as `workerd` does to a client still writing a body it refused unread (ADR
   * 0056), or under every request.
   */
  readonly resets?: "refused-with-length" | "always";
}

/** What the storage behind `server` declares, as `Server.declares` describes it. */
const declarationOf = ({ etags = true, declares }: Server): readonly string[] =>
  declares ?? (etags ? ["writeIfAbsent", "writeIfUnchanged"] : ["writeIfAbsent"]);

/** What `fetch` rejects with where the server reset the connection under the body. */
function connectionReset(): TypeError {
  return new TypeError("fetch failed", {
    cause: Object.assign(new Error("write ECONNRESET"), { code: "ECONNRESET" }),
  });
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
  server: Server,
): Promise<Response> {
  const { flaw, etags = true, resets } = server;
  const declares = declarationOf(server);

  if (resets === "always") throw connectionReset();

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
    etag: nextEtag(),
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

  const precondition = preconditionOf(request.headers, declares, flaw);

  if ("status" in precondition) return new Response(null, { status: precondition.status });

  const bounded = flaw !== "no-limit" && (flaw !== "unbounded-stream" || !streamed);

  if (bounded && bytes.byteLength > maxSize) {
    if (flaw === "partial-on-limit") held.set(key, { ...stored, bytes: bytes.slice(0, maxSize) });

    const resetUnderLength =
      !streamed &&
      (resets === "refused-with-length" || flaw === "stored-on-reset" || flaw === "reset-stream");
    const resetUnderStream = streamed && flaw === "reset-stream";

    if (resetUnderLength && flaw === "stored-on-reset") held.set(key, stored);
    if (resetUnderLength || resetUnderStream) throw connectionReset();

    return new Response(null, { status: 413 });
  }

  if (bytes.byteLength === 0 && flaw === "empty-refused")
    return new Response(null, { status: 400 });

  const { onlyIf } = precondition;

  if (!holds(onlyIf, held.get(key), flaw)) return new Response(null, { status: 412 });
  if (!(flaw === "first-write-wins" && held.has(key))) held.set(key, stored);

  const etag = held.get(key)?.etag ?? "";
  const tagged = etags || flaw === "invented-etag";
  const replaced = typeof onlyIf === "object" && flaw !== "if-match-201";

  return new Response(flaw === "with-body" ? "Created" : null, {
    status: replaced ? 204 : 201,
    headers: tagged ? { etag: flaw === "unquoted-etag" ? etag : `"${etag}"` } : {},
  });
}

type Precondition = "absent" | { readonly etag: string | undefined } | undefined;

const listOfTags = /^(?:W\/)?"[^"]*"(?:[ \t]*,[ \t]*(?:W\/)?"[^"]*")*$/u;

/**
 * What spec 10.5 has a server make of the request's preconditions before the body, short of
 * what `flaw` breaks: the status that refuses the request, or the precondition `put` holds.
 */
function preconditionOf(
  headers: Headers,
  declares: readonly string[],
  flaw: Flaw | undefined,
): { readonly status: number } | { readonly onlyIf: Precondition } {
  const ifMatch = headers.get("if-match");
  const ifNoneMatch = headers.get("if-none-match");
  const malformed = [ifMatch, ifNoneMatch].some(
    (field) => field !== null && field !== "*" && !listOfTags.test(field),
  );
  const tags = [...(ifMatch ?? "").matchAll(/(W\/)?"([^"]*)"/gu)]
    .filter(([, weak, opaque]) => (weak === undefined || flaw === "weak-matches") && opaque !== "")
    .map(([, , opaque]) => opaque);
  const named = new Set(tags);
  const inexpressible =
    (ifMatch === "*" && flaw !== "star-held") ||
    named.size > 1 ||
    (ifNoneMatch !== null && ifNoneMatch !== "*") ||
    (ifMatch === null && headers.has("if-unmodified-since") && flaw !== "unmodified-since-ignored");
  const unsupported =
    flaw !== "unsupported-stored" &&
    ((ifNoneMatch === "*" && !declares.includes("writeIfAbsent")) ||
      (ifMatch !== null && !declares.includes("writeIfUnchanged")));

  if (flaw === "malformed-after-501" && (inexpressible || unsupported)) return { status: 501 };
  if (malformed && flaw !== "malformed-ignored") return { status: 400 };
  if (inexpressible || unsupported) return { status: 501 };
  if (flaw === "if-modified-since-evaluated" && headers.has("if-modified-since")) {
    return { status: 412 };
  }
  if (flaw === "if-range-501" && headers.has("if-range")) return { status: 501 };
  if (ifMatch !== null && ifNoneMatch === "*" && flaw !== "if-match-wins") return { status: 412 };
  if (ifMatch === null) return { onlyIf: ifNoneMatch === "*" ? "absent" : undefined };

  return { onlyIf: { etag: ifMatch === "*" ? "*" : [...named][0] } };
}

/** Whether the object the key holds lets `onlyIf` through at the commit. */
function holds(onlyIf: Precondition, held: Held | undefined, flaw: Flaw | undefined): boolean {
  if (onlyIf === undefined) return true;
  if (onlyIf === "absent") return held === undefined || flaw === "absent-ignored";
  if (held === undefined) return flaw === "free-key-written";

  return onlyIf.etag === "*" || onlyIf.etag === held.etag;
}

/** Runs one case against a server that answers as `answer` does, as `server` describes it. */
async function runAgainst(name: string, server: Server = {}): Promise<void> {
  writes = 0;

  const held = new Map<string, Held>();
  const storage = heldStorage(held, server.etags ?? true, declarationOf(server));
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

test.each(uploadCases.map((source) => source.name))(
  "`%s` passes against a storage declaring neither write capability",
  async (name) => {
    await expect(runAgainst(name, { declares: [] })).resolves.toBeUndefined();
  },
);

test("`upload/max-size` passes against a server resetting the connection under a body it refused unread", async () => {
  await expect(
    runAgainst("upload/max-size", { resets: "refused-with-length" }),
  ).resolves.toBeUndefined();
});

test("a `fetch` rejecting as a network error is thrown on as the cause of an error naming the request", async () => {
  await expect(runAgainst("upload/stores", { resets: "always" })).rejects.toMatchObject({
    message: "`PUT` of 64 KiB as `text/plain` fails as a network error",
    cause: expect.any(TypeError),
  });
});

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
  [
    "upload/max-size",
    { flaw: "reset-stream" },
    "`PUT` of a stream of 1048577 bytes without a length fails as a network error",
  ],
  ["upload/max-size", { flaw: "stored-on-reset" }, "The object after the refused `PUT`s"],
  ["upload/content-encoding", { flaw: "coded-stored" }, "answers 201 and not 415"],
  ["upload/content-encoding", { flaw: "coded-refused-and-stored" }, "holds an object"],
  ["upload/method-not-allowed", { flaw: "post-stored" }, "`POST` answers 201 and not 405"],
  ["upload/method-not-allowed", { flaw: "other-allow" }, "allow"],
  ["upload/invalid-key", { flaw: "invalid-key-400" }, "answers 400 and not 404"],
  ["upload/no-header-metadata", { flaw: "header-metadata" }, "user metadata"],
  ["upload/if-none-match", { flaw: "absent-ignored" }, "answers 201 and not 412"],
  ["upload/if-none-match", { flaw: "unsupported-stored", declares: [] }, "answers 201 and not 501"],
  ["upload/if-match", { flaw: "if-match-201" }, "answers 201 and not 204"],
  ["upload/if-match", { flaw: "weak-matches" }, "as `W/` in `If-Match` answers 204 and not 412"],
  ["upload/if-match", { flaw: "free-key-written" }, "onto a free key answers 204 and not 412"],
  ["upload/if-match", { flaw: "unsupported-stored", declares: [] }, "answers 204 and not 501"],
  ["upload/both-preconditions", { flaw: "if-match-wins" }, "answers 204 and not 412"],
  [
    "upload/inexpressible-precondition",
    { flaw: "star-held" },
    "`If-Match: *` answers 204 and not 501",
  ],
  [
    "upload/inexpressible-precondition",
    { flaw: "unmodified-since-ignored" },
    "`If-Unmodified-Since` alone answers 201 and not 501",
  ],
  ["upload/malformed-precondition", { flaw: "malformed-ignored" }, "answers 412 and not 400"],
  [
    "upload/malformed-precondition",
    { flaw: "malformed-after-501", declares: [] },
    "answers 501 and not 400",
  ],
  [
    "upload/ignored-preconditions",
    { flaw: "if-modified-since-evaluated" },
    "in the past answers 412 and not 201",
  ],
  ["upload/ignored-preconditions", { flaw: "if-range-501" }, "`If-Range` answers 501 and not 201"],
])("`%s` fails against a server with the flaw %o", async (name, server, message) => {
  await expect(runAgainst(name, server)).rejects.toThrow(message);
});
