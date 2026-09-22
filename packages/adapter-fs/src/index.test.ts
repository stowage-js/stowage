import {
  chmod,
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  rm,
  stat,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  isStorageError,
  type ObjectListing,
  type OperationOptions,
  type StorageError,
} from "@stowage/core";
import { afterEach, expect, test } from "vitest";

import { type FsStorage, fsStorage } from "./index.ts";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(
    roots.splice(0).map(async (root) => {
      await chmod(root, 0o700).catch(() => {});
      await rm(root, { recursive: true, force: true });
    }),
  );
});

/** A root of its own per storage, removed once the test that asked for it ended. */
const temporaryRoot = async (): Promise<string> => {
  const root = await mkdtemp(join(tmpdir(), "stowage-fs-"));

  roots.push(root);

  return root;
};

const rootedStorage = async (): Promise<FsStorage> => fsStorage({ root: await temporaryRoot() });

const streamOf = (...chunks: readonly string[]): ReadableStream<Uint8Array> =>
  new ReadableStream({
    start(controller) {
      const encoder = new TextEncoder();

      for (const chunk of chunks) controller.enqueue(encoder.encode(chunk));
      controller.close();
    },
  });

/** Whether one file below a root of its own answers to both Unicode forms of its name. */
const foldsNormalForms = async (composed: string, decomposed: string): Promise<boolean> => {
  const root = await temporaryRoot();

  await writeFile(join(root, composed), "a probe");

  return await stat(join(root, decomposed)).then(
    () => true,
    () => false,
  );
};

const rejection = async (promise: Promise<unknown>): Promise<unknown> => {
  try {
    await promise;
  } catch (error) {
    return error;
  }

  throw new Error("The call resolved where it was expected to reject");
};

const storageErrorOf = async (promise: Promise<unknown>): Promise<StorageError> => {
  const error = await rejection(promise);

  if (!isStorageError(error)) throw new Error(`Not a storage error: ${String(error)}`);

  return error;
};

const codeOf = async (promise: Promise<unknown>): Promise<string> =>
  (await storageErrorOf(promise)).code;

/**
 * An option key the spec does not list. TypeScript refuses one at the call site, so it
 * reaches a call from plain JavaScript alone.
 */
const withUnknownOption = <T extends object>(options: T): T =>
  Object.assign({}, options, { retries: 3 });

/** A value of the wrong type under a listed key, which reaches a call the same way. */
const withContentType = <T extends object>(options: T, contentType: unknown): T =>
  Object.assign({}, options, { contentType });

/** A signal whose second abort check fires at the operation's final commit boundary. */
const abortBeforeCommit = (): OperationOptions => {
  const controller = new AbortController();
  let checks = 0;

  Object.defineProperty(controller.signal, "throwIfAborted", {
    value() {
      checks += 1;

      if (checks === 2) controller.abort();

      AbortSignal.prototype.throwIfAborted.call(controller.signal);
    },
  });

  return { signal: controller.signal };
};

const storageWith = async (...keys: readonly string[]): Promise<FsStorage> => {
  const storage = await rootedStorage();

  await Promise.all(keys.map(async (key) => void (await storage.put(key, key))));

  return storage;
};

const iterate = async (listing: ObjectListing): Promise<string[]> => {
  const keys: string[] = [];

  for await (const entry of listing) keys.push(entry.key);

  return keys;
};

/** The `name` of whatever was thrown, which is how a caller tells an `AbortError` apart. */
const nameOf = (thrown: unknown): string | undefined => {
  if (typeof thrown !== "object" || thrown === null) return undefined;

  const name: unknown = Reflect.get(thrown, "name");

  return typeof name === "string" ? name : undefined;
};

test("names the provider and the root it is bound to", async () => {
  const root = await temporaryRoot();
  const storage = fsStorage({ root });

  expect(storage.provider).toBe("fs");
  expect(storage.bucket).toBe(root);
});

test("declares the capabilities it implements", async () => {
  expect((await rootedStorage()).capabilities).toEqual(["rangeReads"]);
});

test("refuses a root that is no absolute path", () => {
  const error = (() => {
    try {
      return fsStorage({ root: "packages/adapter-fs" });
    } catch (thrown) {
      return thrown;
    }
  })();

  expect(isStorageError(error) && error.code).toBe("InvalidOption");
  expect(isStorageError(error) && error.message).toContain("root");
});

test("refuses an option the configuration does not take", async () => {
  const root = await temporaryRoot();

  expect(() => fsStorage(withUnknownOption({ root }))).toThrow("retries");
});

test("touches the file system at no point of the construction", async () => {
  const storage = fsStorage({ root: join(await temporaryRoot(), "not-there") });

  expect(storage.bucket).toContain("not-there");
  expect(await codeOf(storage.put("object", "a body"))).toBe("NotFound");
  expect(await codeOf(storage.get("object"))).toBe("NotFound");
  expect(await codeOf(storage.stat("object"))).toBe("NotFound");
  expect(await codeOf(storage.exists("object"))).toBe("NotFound");
});

test("writes a body of every shape and reads it back", async () => {
  const storage = await rootedStorage();

  await storage.put("bytes", new Uint8Array([1, 2, 3]));
  await storage.put("text", "Grüße");
  await storage.put("stream", streamOf("one ", "two"));

  expect(await (await storage.get("bytes")).bytes()).toEqual(new Uint8Array([1, 2, 3]));
  expect(await (await storage.get("text")).text()).toBe("Grüße");
  expect(await (await storage.get("stream")).text()).toBe("one two");
});

test("reports the bytes it wrote, and no etag", async () => {
  const storage = await rootedStorage();
  const written = await storage.put("note.txt", "Grüße");

  expect(written.key).toBe("note.txt");
  expect(written.size).toBe(7);
  expect(written.etag).toBeUndefined();
  expect(written.userMetadata).toEqual({});
  expect(Math.abs(Date.now() - written.lastModified.getTime())).toBeLessThan(60_000);
  expect(await storage.stat("note.txt")).toEqual(written);
});

test("creates the directories a key names above the object", async () => {
  const root = await temporaryRoot();

  await fsStorage({ root }).put("docs/2026/report.txt", "a report");

  expect(await readFile(join(root, "docs", "2026", "report.txt"), "utf8")).toBe("a report");
});

test("creates nothing through a directory link leaving the root", async () => {
  const root = await temporaryRoot();
  const outside = await temporaryRoot();

  await symlink(outside, join(root, "link"));

  expect(await codeOf(fsStorage({ root }).put("link/missing/object", "a body"))).toBe("NotFound");
  expect(await readdir(outside)).toEqual([]);
});

test("leaves nothing beside the object a write landed as", async () => {
  const root = await temporaryRoot();

  await fsStorage({ root }).put("object", "a body");

  expect(await readdir(root)).toEqual(["object"]);
});

test("describes an object without holding its file open", async () => {
  const storage = await rootedStorage();

  await storage.put("object", "a body");

  const described = (await storage.get("object")).stat;

  expect(described.size).toBe(6);
  expect(await (await storage.get("object")).text()).toBe("a body");
});

test("derives the content type from the key and stores none it was given", async () => {
  const storage = await rootedStorage();

  await storage.put("note.txt", "a note", { contentType: "application/json" });
  await storage.put("report.PDF", "a report");
  await storage.put("object", "a body");
  await storage.put(".gitignore", "dist");

  expect((await storage.stat("note.txt")).contentType).toBe("text/plain");
  expect((await storage.stat("report.PDF")).contentType).toBe("application/pdf");
  expect((await storage.stat("object")).contentType).toBe("application/octet-stream");
  expect((await storage.stat(".gitignore")).contentType).toBe("application/octet-stream");
});

test("refuses a content type that is no string", async () => {
  const storage = await rootedStorage();

  expect(await codeOf(storage.put("object", "a body", withContentType({}, 7)))).toBe(
    "InvalidOption",
  );
  expect(await storage.exists("object")).toBe(false);
});

test("refuses user metadata and reads back none", async () => {
  const storage = await rootedStorage();
  const refused = await storageErrorOf(
    storage.put("refused", "a body", { userMetadata: { note: "hello" } }),
  );

  expect(refused.code).toBe("Unsupported");
  expect(refused.capability).toBe("userMetadata");

  await storage.put("empty", "a body", { userMetadata: {} });

  expect((await storage.stat("empty")).userMetadata).toEqual({});
  expect((await storage.get("empty")).stat.userMetadata).toEqual({});
});

test("refuses an option a call does not take", async () => {
  const storage = await rootedStorage();

  expect(await codeOf(storage.put("object", "a body", withUnknownOption({})))).toBe(
    "InvalidOption",
  );
  expect(await codeOf(storage.get("object", withUnknownOption({})))).toBe("InvalidOption");
  expect(await codeOf(storage.stat("object", withUnknownOption({})))).toBe("InvalidOption");
  expect(await codeOf(storage.exists("object", withUnknownOption({})))).toBe("InvalidOption");
});

test("refuses a segment above the 255 bytes a name holds", async () => {
  const storage = await rootedStorage();
  const key = `below/${"ü".repeat(128)}`;

  expect(await codeOf(storage.put(key, "a body"))).toBe("InvalidKey");
  expect(await codeOf(storage.get(key))).toBe("InvalidKey");
  expect(await codeOf(storage.exists(key))).toBe("InvalidKey");
});

test("answers for a link leaving the root as for an absent object", async () => {
  const root = await temporaryRoot();
  const outside = join(await temporaryRoot(), "secret");

  await writeFile(outside, "not this storage's");
  await symlink(outside, join(root, "link"));

  const storage = fsStorage({ root });

  expect(await codeOf(storage.get("link"))).toBe("NotFound");
  expect(await codeOf(storage.stat("link"))).toBe("NotFound");
  expect(await storage.exists("link")).toBe(false);
  expect(await codeOf(storage.put("link", "a body"))).toBe("NotFound");
  expect(await readFile(outside, "utf8")).toBe("not this storage's");
});

test("reads a key that names a directory as absent and refuses a write to it", async () => {
  const root = await temporaryRoot();
  const storage = fsStorage({ root });

  await mkdir(join(root, "directory"));

  expect(await codeOf(storage.get("directory"))).toBe("NotFound");
  expect(await codeOf(storage.stat("directory"))).toBe("NotFound");
  expect(await storage.exists("directory")).toBe(false);
  expect(await codeOf(storage.put("directory", "a body"))).toBe("InvalidRequest");
});

test("reads a key below a file as absent and refuses a write to it", async () => {
  const storage = await rootedStorage();

  await storage.put("object", "a body");

  expect(await codeOf(storage.get("object/below"))).toBe("NotFound");
  expect(await codeOf(storage.stat("object/below"))).toBe("NotFound");
  expect(await storage.exists("object/below")).toBe(false);
  expect(await codeOf(storage.put("object/below", "a body"))).toBe("InvalidRequest");
  expect(await codeOf(storage.put("object/below/deeper", "a body"))).toBe("InvalidRequest");
});

test("carries the errno of the failure it reports", async () => {
  const storage = await rootedStorage();
  const missing = await storageErrorOf(storage.get("absent"));

  expect(missing.code).toBe("NotFound");
  expect(missing.providerCode).toBe("ENOENT");
  expect(missing.operation).toBe("get");
  expect(missing.key).toBe("absent");
  expect(missing.attempts).toBe(1);
  expect(missing.retryable).toBe(false);
});

test("reports a directory it may not read as AccessDenied", async () => {
  const root = await temporaryRoot();
  const storage = fsStorage({ root });

  await storage.put("closed/object", "a body");
  await chmod(join(root, "closed"), 0o000);

  const refused = await storageErrorOf(storage.get("closed/object"));

  await chmod(join(root, "closed"), 0o700);

  expect(refused.code).toBe("AccessDenied");
  expect(refused.providerCode).toBe("EACCES");
});

test("asks nothing about a key no file can carry", async () => {
  const storage = await rootedStorage();
  const refused = await storageErrorOf(storage.get("absent/"));

  expect(refused.code).toBe("NotFound");
  expect(refused.attempts).toBe(0);
  expect(refused.providerCode).toBeUndefined();
});

test("answers what is there and what is not", async () => {
  const storage = await rootedStorage();

  await storage.put("object", "a body");

  expect(await storage.exists("object")).toBe(true);
  expect(await storage.exists("absent")).toBe(false);
  expect(await storage.exists("absent/")).toBe(false);
  expect(await storage.exists("object/")).toBe(false);
});

test("reads the range of an object the caller named", async () => {
  const storage = await rootedStorage();

  await storage.put("object", "abcdefghij");

  const middle = await storage.get("object", { range: { start: 2, end: 4 } });

  expect(await middle.text()).toBe("cde");
  expect(middle.stat.size).toBe(10);
  expect(await (await storage.get("object", { range: { start: 7 } })).text()).toBe("hij");
  expect(await (await storage.get("object", { range: { start: 8, end: 99 } })).text()).toBe("ij");
  expect(await codeOf(storage.get("object", { range: { start: 10 } }))).toBe("InvalidRequest");
  expect(await codeOf(storage.get("object", { range: { start: 4, end: 2 } }))).toBe(
    "InvalidOption",
  );
});

test("yields the body as a stream and reads it once", async () => {
  const storage = await rootedStorage();

  await storage.put("object", "a body to read");

  const stored = await storage.get("object");
  const chunks: string[] = [];
  const decoder = new TextDecoder();

  for await (const chunk of stored.stream()) chunks.push(decoder.decode(chunk));

  expect(chunks.join("")).toBe("a body to read");
  expect(await codeOf(stored.text())).toBe("InvalidRequest");

  const canceled = await storage.get("object");

  await canceled.stream().cancel();
});

test("parses a body as JSON and leaves a failure to the runtime", async () => {
  const storage = await rootedStorage();

  await storage.put("object.json", '{"grüße":"日本語"}');
  await storage.put("object.txt", "no JSON in here");

  expect(await (await storage.get("object.json")).json()).toEqual({ grüße: "日本語" });
  expect(await rejection((await storage.get("object.txt")).json())).toBeInstanceOf(SyntaxError);
});

test("rejects with the runtime's AbortError for a signal that already fired", async () => {
  const root = await temporaryRoot();
  const storage = fsStorage({ root });

  await storage.put("object", "a body");

  const aborted = await Promise.all([
    rejection(storage.put("below/written", "a body", { signal: AbortSignal.abort() })),
    rejection(storage.get("object", { signal: AbortSignal.abort() })),
    rejection(storage.stat("object", { signal: AbortSignal.abort() })),
    rejection(storage.exists("object", { signal: AbortSignal.abort() })),
  ]);

  for (const thrown of aborted) {
    expect(isStorageError(thrown)).toBe(false);
    expect(nameOf(thrown)).toBe("AbortError");
  }

  expect(await storage.exists("below/written")).toBe(false);
  // Nothing was created on the way to a body the storage was never going to hold.
  expect(await readdir(root)).toEqual(["object"]);
});

test("writes nothing where the signal fires during the upload", async () => {
  const root = await temporaryRoot();
  const storage = fsStorage({ root });
  const controller = new AbortController();
  const body = new ReadableStream<Uint8Array>({
    pull(streamController) {
      streamController.enqueue(new Uint8Array(1024));
      controller.abort();
    },
  });

  const thrown = await rejection(storage.put("object", body, { signal: controller.signal }));

  expect(nameOf(thrown)).toBe("AbortError");
  expect(await storage.exists("object")).toBe(false);
  expect(await readdir(root)).toEqual([]);
});

test("checks for abortion after the last body write", async () => {
  const root = await temporaryRoot();
  const storage = fsStorage({ root });
  const controller = new AbortController();
  const bytes = new (class extends Uint8Array {
    override get byteLength(): number {
      controller.abort();

      return super.byteLength;
    }
  })([1, 2, 3]);

  const thrown = await rejection(storage.put("object", bytes, { signal: controller.signal }));

  expect(nameOf(thrown)).toBe("AbortError");
  expect(await storage.exists("object")).toBe(false);
  expect(await readdir(root)).toEqual([]);
});

test("leaves the stream it was handed at its end or canceled", async () => {
  const storage = await rootedStorage();
  const written = streamOf("a body");
  const refused = streamOf("another body");

  await storage.put("object", written);
  await rejection(storage.put("..", refused));

  expect(written.locked).toBe(false);
  expect((await written.getReader().read()).done).toBe(true);
  expect((await refused.getReader().read()).done).toBe(true);
});

test("yields every object below the prefix once", async () => {
  const storage = await storageWith("a", "docs/one.txt", "docs/2026/two.txt", "other");

  expect(await iterate(storage.list({ prefix: "docs/" }))).toEqual([
    "docs/2026/two.txt",
    "docs/one.txt",
  ]);
  expect((await iterate(storage.list())).toSorted()).toEqual([
    "a",
    "docs/2026/two.txt",
    "docs/one.txt",
    "other",
  ]);
});

test("describes every entry a listing yields", async () => {
  const storage = await storageWith("docs/one.txt");
  const [entry] = (await storage.list().page()).objects;

  expect(entry?.key).toBe("docs/one.txt");
  expect(entry?.size).toBe(12);
  expect(entry?.etag).toBeUndefined();
  expect(Math.abs(Date.now() - (entry?.lastModified.getTime() ?? 0))).toBeLessThan(60_000);
});

test("pages with a cursor a later call continues from", async () => {
  const storage = await storageWith("1", "2", "3", "4", "5");
  const first = await storage.list({ pageSize: 2 }).page();
  const second = await storage.list({ pageSize: 2, cursor: first.cursor }).page();
  const third = await storage.list({ pageSize: 2, cursor: second.cursor }).page();

  expect([first, second, third].map((page) => page.objects.length)).toEqual([2, 2, 1]);
  expect(third.cursor).toBeUndefined();
  expect([first, second, third].flatMap((page) => page.objects.map((entry) => entry.key))).toEqual([
    "1",
    "2",
    "3",
    "4",
    "5",
  ]);
});

test("names the level below the prefix a delimiter cuts", async () => {
  const storage = await storageWith("docs/one.txt", "docs/2026/two.txt", "docs/2027/three.txt");
  const page = await storage.list({ prefix: "docs/", delimiter: "/" }).page();

  expect(page.objects.map((entry) => entry.key)).toEqual(["docs/one.txt"]);
  expect(page.prefixes).toEqual(["docs/2026/", "docs/2027/"]);
  expect(await iterate(storage.list({ prefix: "docs/", delimiter: "/" }))).toEqual([
    "docs/one.txt",
  ]);
});

test("matches a prefix that ends inside a segment", async () => {
  const storage = await storageWith("docs/report-1", "docs/report-2", "docs/summary");

  expect(await iterate(storage.list({ prefix: "docs/report" }))).toEqual([
    "docs/report-1",
    "docs/report-2",
  ]);
});

test("refuses what a listing does not take, once it is read", async () => {
  const storage = await rootedStorage();

  // Spec 4.6: `list` performs nothing until the listing is iterated or asked for a page,
  // so a refusal reaches the caller there and not at the call.
  const refused = storage.list({ pageSize: 0 });

  expect(await codeOf(refused.page())).toBe("InvalidOption");
  expect(await codeOf(storage.list({ pageSize: 1001 }).page())).toBe("InvalidOption");
  expect(await codeOf(storage.list({ delimiter: "" }).page())).toBe("InvalidOption");
  expect(await codeOf(storage.list({ cursor: "not one of ours" }).page())).toBe("InvalidOption");
  expect(await codeOf(storage.list(withUnknownOption({})).page())).toBe("InvalidOption");
  expect(await codeOf(storage.list({ prefix: "../elsewhere" }).page())).toBe("InvalidKey");
});

test("passes over what is no object of the storage", async () => {
  const root = await temporaryRoot();
  const outside = join(await temporaryRoot(), "secret");
  const storage = fsStorage({ root });

  await storage.put("object", "a body");
  await writeFile(join(root, `.stowage-${crypto.randomUUID()}.tmp`), "a write in flight");
  await writeFile(outside, "not this storage's");
  await symlink(outside, join(root, "link"));
  await mkdir(join(root, "empty"));

  expect(await iterate(storage.list())).toEqual(["object"]);
});

test("does not walk an external directory through a prefix link", async () => {
  const root = await temporaryRoot();
  const outside = await temporaryRoot();
  const storage = fsStorage({ root });

  await writeFile(join(outside, "secret"), "not this storage's");
  await symlink(outside, join(root, "link"));

  expect(await iterate(storage.list({ prefix: "link/" }))).toEqual([]);
});

test("reserves temporary file names from writable keys", async () => {
  const storage = await rootedStorage();
  const reserved = `.stowage-${crypto.randomUUID()}.tmp`;
  const ordinary = ".stowage-not-a-temporary-file.tmp";

  expect(await codeOf(storage.put(reserved, "hidden"))).toBe("InvalidKey");
  await storage.put(ordinary, "visible");

  expect(await iterate(storage.list())).toEqual([ordinary]);
});

test("reports a root that is gone where the listing is read", async () => {
  const storage = fsStorage({ root: join(await temporaryRoot(), "not-there") });

  expect(await codeOf(storage.list().page())).toBe("NotFound");
  expect(await codeOf(iterate(storage.list()))).toBe("NotFound");
});

test("deletes the keys it was handed and reports what it covered", async () => {
  const storage = await storageWith("one", "docs/two.txt");
  const report = await storage.delete("one", "docs/two.txt", "never-written");

  // Spec 4.7 counts the keys the call covered, and deleting is idempotent, so the key
  // that was never there is one the storage took like the two it removed.
  expect(report).toEqual({ requested: 3, failed: [] });
  expect(await iterate(storage.list())).toEqual([]);
});

test("reports an invalid key beside the keys it deleted", async () => {
  const storage = await storageWith("one", "two");
  const report = await storage.delete("one", "../elsewhere", "two");

  expect(report.requested).toBe(3);
  expect(report.failed.map((failure) => [failure.code, failure.key])).toEqual([
    ["InvalidKey", "../elsewhere"],
  ]);
  expect(await iterate(storage.list())).toEqual([]);
});

test("covers no key at all", async () => {
  expect(await (await rootedStorage()).delete()).toEqual({ requested: 0, failed: [] });
});

test("removes the directories a delete leaves empty", async () => {
  const root = await temporaryRoot();
  const storage = fsStorage({ root });

  await storage.put("docs/2026/one.txt", "a body");
  await storage.put("docs/two.txt", "another body");
  await storage.delete("docs/2026/one.txt");

  expect(await readdir(join(root, "docs"))).toEqual(["two.txt"]);

  await storage.delete("docs/two.txt");

  expect(await readdir(root)).toEqual([]);
});

test("removes the link at the key and not the object it points to", async () => {
  const root = await temporaryRoot();
  const storage = fsStorage({ root });

  await storage.put("object", "a body");
  await symlink(join(root, "object"), join(root, "link"));

  expect(await storage.delete("link")).toEqual({ requested: 1, failed: [] });
  expect(await iterate(storage.list())).toEqual(["object"]);
});

test("leaves what is no object of this storage where it is", async () => {
  const root = await temporaryRoot();
  const outside = join(await temporaryRoot(), "secret");
  const storage = fsStorage({ root });

  await writeFile(outside, "not this storage's");
  await symlink(outside, join(root, "link"));
  await storage.put("docs/one.txt", "a body");

  // A directory and a link leaving the root are no objects a listing names, so a delete
  // of them removes nothing and reports nothing either (spec 4.7).
  expect(await storage.delete("docs", "link")).toEqual({ requested: 2, failed: [] });
  expect(await readFile(outside, "utf8")).toBe("not this storage's");
  expect(await iterate(storage.list())).toEqual(["docs/one.txt"]);
  expect((await readdir(root)).toSorted()).toEqual(["docs", "link"]);
});

test("deletes every object below the prefix and none beside it", async () => {
  const storage = await storageWith("docs/one.txt", "docs/2026/two.txt", "docs-beside", "other");

  expect(await storage.deleteAll("docs/")).toEqual({ requested: 2, failed: [] });
  expect(await iterate(storage.list())).toEqual(["docs-beside", "other"]);
});

test("removes the directories a deleteAll leaves empty", async () => {
  const root = await temporaryRoot();
  const storage = fsStorage({ root });

  await storage.put("docs/2026/one.txt", "a body");

  expect(await storage.deleteAll("docs/")).toEqual({ requested: 1, failed: [] });
  expect(await readdir(root)).toEqual([]);
});

test("covers nothing below a prefix that holds no object", async () => {
  const storage = await storageWith("other");

  expect(await storage.deleteAll("docs/")).toEqual({ requested: 0, failed: [] });
});

test("refuses what a deleteAll does not take", async () => {
  const storage = await rootedStorage();

  expect(await codeOf(storage.deleteAll("../elsewhere"))).toBe("InvalidKey");
  expect(await codeOf(storage.deleteAll("docs/", withUnknownOption({})))).toBe("InvalidOption");
});

test("rejects a delete against a root that is gone", async () => {
  const storage = fsStorage({ root: join(await temporaryRoot(), "not-there") });

  expect(await codeOf(storage.delete("object"))).toBe("NotFound");
  expect(await codeOf(storage.deleteAll("docs/"))).toBe("NotFound");
});

test("copies the bytes and derives the type from the destination key", async () => {
  const storage = await storageWith("docs/one.txt");
  const written = await storage.copy("docs/one.txt", "copies/one.json");

  // Spec 6 derives the content type from the key, so a copy under another extension is
  // described by the extension it arrived under and not by the one it came from.
  expect(written).toMatchObject({
    key: "copies/one.json",
    size: 12,
    contentType: "application/json",
  });
  expect(await (await storage.get("copies/one.json")).text()).toBe("docs/one.txt");
  expect(await (await storage.get("docs/one.txt")).text()).toBe("docs/one.txt");
});

test("replaces the object a copy lands on", async () => {
  const storage = await storageWith("one", "two");

  await storage.copy("one", "two");

  expect(await (await storage.get("two")).text()).toBe("one");
});

test("does not land a copy after its signal aborts", async () => {
  const storage = await storageWith("source", "destination");
  const thrown = await rejection(storage.copy("source", "destination", abortBeforeCommit()));

  expect(nameOf(thrown)).toBe("AbortError");
  expect(await (await storage.get("source")).text()).toBe("source");
  expect(await (await storage.get("destination")).text()).toBe("destination");
});

test("refuses a copy onto itself before it touches the file system", async () => {
  const storage = await storageWith("object");
  const error = await storageErrorOf(storage.copy("object", "object"));

  expect(error.code).toBe("InvalidRequest");
  expect(error.attempts).toBe(0);
  expect(await (await storage.get("object")).text()).toBe("object");
});

test("rejects a copy whose source is not there and writes nothing", async () => {
  const root = await temporaryRoot();
  const storage = fsStorage({ root });
  const error = await storageErrorOf(storage.copy("absent", "copies/one.txt"));

  expect(error.code).toBe("NotFound");
  expect(error.operation).toBe("copy");
  // Nothing was created on the way to a body the storage was never going to hold.
  expect(await readdir(root)).toEqual([]);
});

test("refuses the keys a copy does not take", async () => {
  const storage = await storageWith("source");

  expect(await codeOf(storage.copy("source", "destination/"))).toBe("InvalidKey");
  expect(await codeOf(storage.copy("../source", "destination"))).toBe("InvalidKey");
  expect(await codeOf(storage.copy("source", "destination", withUnknownOption({})))).toBe(
    "InvalidOption",
  );
  expect(await iterate(storage.list())).toEqual(["source"]);
});

test("moves the object and removes what the move left empty", async () => {
  const root = await temporaryRoot();
  const storage = fsStorage({ root });

  await storage.put("docs/2026/one.txt", "a body");

  const written = await storage.move("docs/2026/one.txt", "archive/one.txt");

  expect(written).toMatchObject({ key: "archive/one.txt", size: 6, contentType: "text/plain" });
  expect(await (await storage.get("archive/one.txt")).text()).toBe("a body");
  expect(await storage.exists("docs/2026/one.txt")).toBe(false);
  expect(await readdir(root)).toEqual(["archive"]);
});

test("does not move an object after its signal aborts", async () => {
  const storage = await storageWith("source", "destination");
  const thrown = await rejection(storage.move("source", "destination", abortBeforeCommit()));

  expect(nameOf(thrown)).toBe("AbortError");
  expect(await (await storage.get("source")).text()).toBe("source");
  expect(await (await storage.get("destination")).text()).toBe("destination");
});

test("rejects a move whose source is not there", async () => {
  const storage = await rootedStorage();
  const error = await storageErrorOf(storage.move("absent", "destination"));

  expect(error.code).toBe("NotFound");
  expect(error.operation).toBe("move");
  expect(await storage.exists("destination")).toBe(false);
});

test("moves the link at the key and leaves the object it points to", async () => {
  const root = await temporaryRoot();
  const storage = fsStorage({ root });

  await storage.put("object", "a body");
  await symlink(join(root, "object"), join(root, "link"));

  await storage.move("link", "moved");

  expect((await iterate(storage.list())).toSorted()).toEqual(["moved", "object"]);
  expect(await (await storage.get("object")).text()).toBe("a body");
});

test("rejects a copy or a move against a root that is gone", async () => {
  const storage = fsStorage({ root: join(await temporaryRoot(), "not-there") });

  expect(await codeOf(storage.copy("source", "destination"))).toBe("NotFound");
  expect(await codeOf(storage.move("source", "destination"))).toBe("NotFound");
});

test("hands a key back as the file system holds it", async () => {
  const storage = await rootedStorage();
  const composed = `caf${String.fromCodePoint(0xe9)}.txt`;
  const decomposed = `cafe${String.fromCodePoint(0x301)}.txt`;

  await storage.put(composed, "a body");

  // The key comes back in the form it went in, because APFS keeps the form a name was
  // written in and ext4 keeps the bytes.
  expect(await iterate(storage.list())).toEqual([composed]);

  // Whether the other form reaches the same object is the file system's own answer, and
  // spec 6 has the storage pass it on rather than repair it: APFS folds the two forms and
  // ext4 tells them apart, which is why no `keyBytesPreserved` is declared.
  expect(await storage.exists(decomposed)).toBe(await foldsNormalForms(composed, decomposed));
  expect(storage.capabilities).not.toContain("keyBytesPreserved");
});
