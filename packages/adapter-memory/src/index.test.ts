import { isStorageError, type StorageError, type StoredObject } from "@stowage/core";
import { expect, test } from "vitest";

import { type MemoryStorage, memoryStorage } from "./index.ts";

/** SHA-256 of the five bytes of `hello`, which is what `etag` promises. */
const helloDigest = "2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824";

const streamOf = (...chunks: readonly string[]): ReadableStream<Uint8Array> =>
  new ReadableStream({
    start(controller) {
      const encoder = new TextEncoder();

      for (const chunk of chunks) controller.enqueue(encoder.encode(chunk));
      controller.close();
    },
  });

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

const storedDocument = async (): Promise<StoredObject> => {
  const storage = memoryStorage();
  await storage.put("document", "{}");

  return await storage.get("document");
};

test("names the provider and the bucket it is bound to", () => {
  const storage = memoryStorage();

  expect(storage.provider).toBe("memory");
  expect(storage.bucket).toBe("memory");
});

test("shares nothing with a second storage", async () => {
  const one = memoryStorage();
  const other = memoryStorage();

  await one.put("greeting", "hello");

  expect(await other.exists("greeting")).toBe(false);
});

test("takes bytes and hands them back", async () => {
  const storage = memoryStorage();
  const body = new Uint8Array([1, 2, 3]);

  const stat = await storage.put("bytes", body);
  const stored = await storage.get("bytes");

  expect(stat.size).toBe(3);
  expect(await stored.bytes()).toEqual(body);
});

test("stores a string as its UTF-8 bytes", async () => {
  const storage = memoryStorage();

  const stat = await storage.put("greeting", "grüße");

  expect(stat.size).toBe(7);
  expect(await (await storage.get("greeting")).bytes()).toEqual(new TextEncoder().encode("grüße"));
  expect(await (await storage.get("greeting")).text()).toBe("grüße");
});

test("reads a stream to its end", async () => {
  const storage = memoryStorage();

  const stat = await storage.put("greeting", streamOf("hel", "lo"));

  expect(stat.size).toBe(5);
  expect(await (await storage.get("greeting")).text()).toBe("hello");
});

test("copies chunks from a stream", async () => {
  const storage = memoryStorage();
  const chunk = new Uint8Array([1, 2, 3]);
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(chunk);
      setTimeout(() => {
        chunk[0] = 9;
        controller.close();
      });
    },
  });

  await storage.put("bytes", body);

  expect(await (await storage.get("bytes")).bytes()).toEqual(new Uint8Array([1, 2, 3]));
});

test("leaves the stream it read at its end", async () => {
  const storage = memoryStorage();
  const body = streamOf("hello");

  await storage.put("greeting", body);

  expect(body.locked).toBe(false);
  expect(await body.getReader().read()).toEqual({ done: true, value: undefined });
});

test("hands the body back as a stream", async () => {
  const storage = memoryStorage();
  await storage.put("greeting", "hello");

  const stored = await storage.get("greeting");

  expect(await new Response(stored.stream()).text()).toBe("hello");
});

test("parses the body as JSON", async () => {
  const storage = memoryStorage();
  await storage.put("document", JSON.stringify({ greeting: "hello" }));

  const stored = await storage.get("document");

  expect(await stored.json()).toEqual({ greeting: "hello" });
});

test("reports a body that is not JSON as the runtime does", async () => {
  const storage = memoryStorage();
  await storage.put("document", "not json");

  const error = await rejection((await storage.get("document")).json());

  expect(error).toBeInstanceOf(SyntaxError);
  expect(isStorageError(error)).toBe(false);
});

test("describes the object it hands back without a second call", async () => {
  const storage = memoryStorage();

  const written = await storage.put("greeting", "hello", { contentType: "text/plain" });
  const stored = await storage.get("greeting");

  expect(stored.stat).toEqual(written);
  expect(stored.stat).toEqual(await storage.stat("greeting"));
});

test.each([
  ["bytes", async (stored: StoredObject) => await stored.bytes()],
  ["text", async (stored: StoredObject) => await stored.text()],
  ["json", async (stored: StoredObject) => await stored.json()],
  ["stream", async (stored: StoredObject) => await new Response(stored.stream()).arrayBuffer()],
])("refuses a second read through %s", async (_name, second) => {
  const stored = await storedDocument();
  await stored.bytes();

  const error = await storageErrorOf(second(stored));

  expect(error.code).toBe("InvalidRequest");
});

test("answers for a key that is there", async () => {
  const storage = memoryStorage();
  await storage.put("greeting", "hello");

  expect(await storage.exists("greeting")).toBe(true);
  expect((await storage.stat("greeting")).key).toBe("greeting");
});

test.each(["get", "stat"] as const)("reports an absent key to %s as not found", async (name) => {
  const storage = memoryStorage();

  const error = await storageErrorOf(storage[name]("absent"));

  expect(error.code).toBe("NotFound");
  expect(error.key).toBe("absent");
  expect(error.operation).toBe(name);
  expect(error.attempts).toBe(1);
});

test("answers `false` for an absent key", async () => {
  expect(await memoryStorage().exists("absent")).toBe(false);
});

test("gives an object put without a content type the default one", async () => {
  const storage = memoryStorage();

  const stat = await storage.put("greeting", "hello");

  expect(stat.contentType).toBe("application/octet-stream");
  expect(stat.userMetadata).toEqual({});
});

test("replaces the bytes and the content type under a key that is taken", async () => {
  const storage = memoryStorage();
  await storage.put("greeting", "hello", { contentType: "text/plain" });

  await storage.put("greeting", "servus", { contentType: "text/markdown" });
  const stored = await storage.get("greeting");

  expect(await stored.text()).toBe("servus");
  expect(stored.stat.contentType).toBe("text/markdown");
});

test("copies the bytes it was handed", async () => {
  const storage = memoryStorage();
  const body = new Uint8Array([1, 2, 3]);

  await storage.put("bytes", body);
  body[0] = 9;

  expect(await (await storage.get("bytes")).bytes()).toEqual(new Uint8Array([1, 2, 3]));
});

test("copies the bytes it hands back", async () => {
  const storage = memoryStorage();
  await storage.put("bytes", new Uint8Array([1, 2, 3]));

  const handed = await (await storage.get("bytes")).bytes();
  handed[0] = 9;

  expect(await (await storage.get("bytes")).bytes()).toEqual(new Uint8Array([1, 2, 3]));
});

test("copies the bytes it streams back", async () => {
  const storage = memoryStorage();
  await storage.put("bytes", new Uint8Array([1, 2, 3]));

  const chunk = await (await storage.get("bytes")).stream().getReader().read();
  chunk.value?.set([9], 0);

  expect(await (await storage.get("bytes")).bytes()).toEqual(new Uint8Array([1, 2, 3]));
});

test("reports the SHA-256 of the bytes as the ETag", async () => {
  const storage = memoryStorage();

  const stat = await storage.put("greeting", "hello");

  expect(stat.etag).toBe(helloDigest);
  expect((await storage.stat("greeting")).etag).toBe(helloDigest);
});

test("stores nothing under a signal that has already fired", async () => {
  const storage = memoryStorage();

  const error = await rejection(storage.put("greeting", "hello", { signal: AbortSignal.abort() }));

  expect(error).toHaveProperty("name", "AbortError");
  expect(isStorageError(error)).toBe(false);
  expect(await storage.exists("greeting")).toBe(false);
});

test("cancels a stream body it refuses to read", async () => {
  let canceled = false;
  const body = new ReadableStream<Uint8Array>({
    cancel() {
      canceled = true;
    },
  });

  const error = await rejection(
    memoryStorage().put("greeting", body, { signal: AbortSignal.abort() }),
  );

  expect(error).toHaveProperty("name", "AbortError");
  expect(canceled).toBe(true);
});

test("cancels a stream body the signal interrupts", async () => {
  const storage = memoryStorage();
  const aborter = new AbortController();
  let canceled = false;
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(new TextEncoder().encode("hel"));
    },
    cancel() {
      canceled = true;
    },
  });

  const put = storage.put("greeting", body, { signal: aborter.signal });
  aborter.abort();
  const error = await rejection(put);

  expect(error).toHaveProperty("name", "AbortError");
  expect(canceled).toBe(true);
  expect(await storage.exists("greeting")).toBe(false);
});

test.each([
  ["get", async (signal: AbortSignal) => await memoryStorage().get("greeting", { signal })],
  ["stat", async (signal: AbortSignal) => await memoryStorage().stat("greeting", { signal })],
  ["exists", async (signal: AbortSignal) => await memoryStorage().exists("greeting", { signal })],
  ["deleteAll", async (signal: AbortSignal) => await memoryStorage().deleteAll("", { signal })],
  [
    "copy",
    async (signal: AbortSignal) => await memoryStorage().copy("greeting", "formal", { signal }),
  ],
  [
    "move",
    async (signal: AbortSignal) => await memoryStorage().move("greeting", "formal", { signal }),
  ],
])("reports a signal that has already fired to %s", async (_name, call) => {
  const error = await rejection(call(AbortSignal.abort()));

  expect(error).toHaveProperty("name", "AbortError");
  expect(isStorageError(error)).toBe(false);
});

test.each([
  ["put", (signal: AbortSignal) => memoryStorage().put("greeting", "hello", { signal })],
  ["get", (signal: AbortSignal) => memoryStorage().get("greeting", { signal })],
  ["stat", (signal: AbortSignal) => memoryStorage().stat("greeting", { signal })],
  ["exists", (signal: AbortSignal) => memoryStorage().exists("greeting", { signal })],
  ["deleteAll", (signal: AbortSignal) => memoryStorage().deleteAll("", { signal })],
  ["copy", (signal: AbortSignal) => memoryStorage().copy("greeting", "formal", { signal })],
  ["move", (signal: AbortSignal) => memoryStorage().move("greeting", "formal", { signal })],
])("rejects rather than throwing where %s fails", async (_name, call) => {
  let promise: Promise<unknown> = Promise.resolve();

  expect(() => {
    promise = call(AbortSignal.abort());
  }).not.toThrow();

  expect(await rejection(promise)).toHaveProperty("name", "AbortError");
});

test.each([
  ["the empty string", ""],
  ["a leading slash", "/greeting"],
  ["a trailing slash", "greeting/"],
  ["an empty segment", "greetings//formal"],
  ["a dot-dot segment", "greetings/../formal"],
  ["a backslash", "greetings\\formal"],
  ["a control character", "greeting\u0000"],
  ["1025 bytes", "a".repeat(1025)],
])("refuses to put under a key holding %s", async (_name, key) => {
  const error = await storageErrorOf(memoryStorage().put(key, "hello"));

  expect(error.code).toBe("InvalidKey");
  expect(error.operation).toBe("put");
  expect(error.key).toBe(key);
  expect(error.attempts).toBe(0);
});

test.each([
  ["the empty string", ""],
  ["a leading slash", "/greeting"],
  ["an empty segment", "greetings//formal"],
  ["a dot segment", "./greeting"],
  ["a dot-dot segment", "greetings/../formal"],
  ["nothing but a dot segment", "."],
  ["a control character", "greeting\u0000"],
])("refuses to address a key holding %s", async (_name, key) => {
  const error = await storageErrorOf(memoryStorage().get(key));

  expect(error.code).toBe("InvalidKey");
  expect(error.operation).toBe("get");
  expect(error.key).toBe(key);
  expect(error.attempts).toBe(0);
});

test.each([
  ["get", (storage: MemoryStorage, key: string) => storage.get(key)],
  ["stat", (storage: MemoryStorage, key: string) => storage.stat(key)],
  ["exists", (storage: MemoryStorage, key: string) => storage.exists(key)],
])("applies the addressable rule to %s", async (operation, call) => {
  const storage = memoryStorage();

  const error = await storageErrorOf(call(storage, "greetings//formal"));

  expect(error.code).toBe("InvalidKey");
  expect(error.operation).toBe(operation);
});

test.each([
  ["a trailing slash", "greeting/"],
  ["a backslash", "greetings\\formal"],
  ["1025 bytes", "a".repeat(1025)],
])("addresses a key holding %s that it refuses to write", async (_name, key) => {
  const storage = memoryStorage();

  expect(await storage.exists(key)).toBe(false);
  expect((await storageErrorOf(storage.get(key))).code).toBe("NotFound");
  expect((await storageErrorOf(storage.stat(key))).code).toBe("NotFound");
  expect((await storageErrorOf(storage.put(key, "hello"))).code).toBe("InvalidKey");
});

test("stores a key as it was given rather than in a normalized form", async () => {
  const storage = memoryStorage();
  const composed = "Grüße/日本語/ключ.txt";
  const decomposed = composed.normalize("NFD");

  const stat = await storage.put(composed, "hello");
  await storage.put(decomposed, "servus");

  expect(stat.key).toBe(composed);
  expect(await (await storage.get(composed)).text()).toBe("hello");
  expect(await (await storage.get(decomposed)).text()).toBe("servus");
});

test("stores nothing and reads no body where the key of a put is invalid", async () => {
  const storage = memoryStorage();
  const body = streamOf("hello");

  await storageErrorOf(storage.put("greeting/", body));

  expect(body.locked).toBe(false);
  expect(await storage.exists("greeting/")).toBe(false);
});

test("removes the keys it was given", async () => {
  const storage = memoryStorage();
  await storage.put("greeting", "hello");
  await storage.put("greetings/formal", "servus");

  const report = await storage.delete("greeting", "greetings/formal");

  expect(report).toEqual({ requested: 2, failed: [] });
  expect(await storage.exists("greeting")).toBe(false);
  expect(await storage.exists("greetings/formal")).toBe(false);
});

test("succeeds in deleting a key that is not there", async () => {
  expect(await memoryStorage().delete("absent")).toEqual({ requested: 1, failed: [] });
});

test("resolves with an empty report where it is given no key", async () => {
  expect(await memoryStorage().delete()).toEqual({ requested: 0, failed: [] });
});

test("reports an invalid key in the report and deletes the other keys", async () => {
  const storage = memoryStorage();
  await storage.put("greeting", "hello");

  const report = await storage.delete("greetings//formal", "greeting");

  expect(report.requested).toBe(2);
  expect(report.failed).toHaveLength(1);
  expect(isStorageError(report.failed[0])).toBe(true);
  expect(report.failed[0]?.code).toBe("InvalidKey");
  expect(report.failed[0]?.retryable).toBe(false);
  expect(report.failed[0]?.key).toBe("greetings//formal");
  expect(report.failed[0]?.operation).toBe("delete");
  expect(report.failed[0]?.attempts).toBe(0);
  expect(await storage.exists("greeting")).toBe(false);
});

test("deletes every object below a prefix and none beside it", async () => {
  const storage = memoryStorage();
  await storage.put("greetings/formal", "servus");
  await storage.put("greetings/casual", "hi");
  await storage.put("greeting", "hello");

  const report = await storage.deleteAll("greetings/");

  expect(report).toEqual({ requested: 2, failed: [] });
  expect(await storage.exists("greeting")).toBe(true);
  expect(await storage.exists("greetings/formal")).toBe(false);
});

test("deletes below a prefix that ends in the middle of a segment", async () => {
  const storage = memoryStorage();
  await storage.put("greetings/formal", "servus");
  await storage.put("greeting", "hello");

  await storage.deleteAll("greetin");

  expect(await storage.exists("greeting")).toBe(false);
  expect(await storage.exists("greetings/formal")).toBe(false);
});

test("empties the storage under the empty prefix", async () => {
  const storage = memoryStorage();
  await storage.put("greeting", "hello");
  await storage.put("greetings/formal", "servus");

  expect(await storage.deleteAll("")).toEqual({ requested: 2, failed: [] });
  expect(await storage.exists("greeting")).toBe(false);
});

test("applies the prefix rule to deleteAll", async () => {
  const error = await storageErrorOf(memoryStorage().deleteAll("greetings//formal"));

  expect(error.code).toBe("InvalidKey");
  expect(error.operation).toBe("deleteAll");
  expect(error.attempts).toBe(0);
});

test("copies the bytes and the description of the source to the destination", async () => {
  const storage = memoryStorage();
  const source = await storage.put("greeting", "hello", { contentType: "text/plain" });

  const copied = await storage.copy("greeting", "greetings/formal");

  expect(copied.key).toBe("greetings/formal");
  expect(copied.contentType).toBe("text/plain");
  expect(copied.etag).toBe(source.etag);
  expect(copied.size).toBe(source.size);
  expect(copied.userMetadata).toEqual(source.userMetadata);
  expect(copied).toEqual(await storage.stat("greetings/formal"));
  expect(await (await storage.get("greetings/formal")).text()).toBe("hello");
  expect(await (await storage.get("greeting")).text()).toBe("hello");
});

test("replaces the object at the destination of a copy", async () => {
  const storage = memoryStorage();
  await storage.put("greeting", "hello", { contentType: "text/plain" });
  await storage.put("greetings/formal", "servus", { contentType: "text/markdown" });

  await storage.copy("greeting", "greetings/formal");
  const stored = await storage.get("greetings/formal");

  expect(await stored.text()).toBe("hello");
  expect(stored.stat.contentType).toBe("text/plain");
});

test.each(["copy", "move"] as const)("refuses %s onto the key it reads", async (operation) => {
  const storage = memoryStorage();
  const written = await storage.put("greeting", "hello");

  const error = await storageErrorOf(storage[operation]("greeting", "greeting"));

  expect(error.code).toBe("InvalidRequest");
  expect(error.operation).toBe(operation);
  expect(error.attempts).toBe(0);
  expect(await storage.stat("greeting")).toEqual(written);
});

test.each(["copy", "move"] as const)(
  "reports a missing source of %s as not found",
  async (operation) => {
    const storage = memoryStorage();

    const error = await storageErrorOf(storage[operation]("absent", "greeting"));

    expect(error.code).toBe("NotFound");
    expect(error.key).toBe("absent");
    expect(error.operation).toBe(operation);
    expect(error.attempts).toBe(1);
    expect(await storage.exists("greeting")).toBe(false);
  },
);

test.each(["copy", "move"] as const)(
  "applies the addressable rule to the source of %s",
  async (operation) => {
    const storage = memoryStorage();

    const error = await storageErrorOf(storage[operation]("greetings//formal", "greeting"));

    expect(error.code).toBe("InvalidKey");
    expect(error.key).toBe("greetings//formal");
    expect(error.operation).toBe(operation);
    expect(error.attempts).toBe(0);
    expect(await storage.exists("greeting")).toBe(false);
  },
);

test.each(["copy", "move"] as const)(
  "checks the destination of %s before it touches the source",
  async (operation) => {
    const storage = memoryStorage();
    await storage.put("greeting", "hello");

    const error = await storageErrorOf(storage[operation]("greeting", "greetings/formal/"));

    expect(error.code).toBe("InvalidKey");
    expect(error.key).toBe("greetings/formal/");
    expect(error.operation).toBe(operation);
    expect(error.attempts).toBe(0);
    expect(await storage.exists("greetings/formal/")).toBe(false);
    expect(await (await storage.get("greeting")).text()).toBe("hello");
  },
);

test("replaces the object at the destination of a move", async () => {
  const storage = memoryStorage();
  await storage.put("greeting", "hello", { contentType: "text/plain" });
  await storage.put("greetings/formal", "servus", { contentType: "text/markdown" });

  const moved = await storage.move("greeting", "greetings/formal");

  expect(moved.contentType).toBe("text/plain");
  expect(await (await storage.get("greetings/formal")).text()).toBe("hello");
  expect(await storage.exists("greeting")).toBe(false);
});

test("moves the object and resolves with the description of the destination", async () => {
  const storage = memoryStorage();
  await storage.put("greeting", "hello", { contentType: "text/plain" });

  const moved = await storage.move("greeting", "greetings/formal");

  expect(moved).toEqual(await storage.stat("greetings/formal"));
  expect(moved.contentType).toBe("text/plain");
  expect(await (await storage.get("greetings/formal")).text()).toBe("hello");
  expect(await storage.exists("greeting")).toBe(false);
});
