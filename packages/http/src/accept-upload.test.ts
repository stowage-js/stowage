import type { Storage, StorageErrorFields } from "@stowage/core";
import { describe, expect, test } from "vitest";

import { acceptUpload, type AcceptUploadOptions, objectStatOf, storageErrorOf } from "./index.ts";
import { holdingStorage, statOf, storageError, stubStorage } from "./stubs.ts";

const bytes = (text: string): Uint8Array<ArrayBuffer> => new TextEncoder().encode(text);

const text = (held: Uint8Array | undefined): string | undefined =>
  held === undefined ? undefined : new TextDecoder().decode(held);

/** A `PUT` of `body`, which a `Uint8Array` sends without the `Content-Type` a string gets. */
const upload = (
  body: BodyInit | null,
  fields: {
    readonly method?: string;
    readonly headers?: HeadersInit;
    readonly signal?: AbortSignal;
  } = {},
): Request =>
  new Request("http://localhost/uploads/report", {
    method: fields.method ?? "PUT",
    headers: fields.headers,
    signal: fields.signal,
    body,
    // Node and Deno take a stream as a body only with `duplex`, which no lib declares.
    ...({ duplex: "half" } as object),
  });

/** A body handing over `chunks` one by one as they are read, then ending or failing. */
function streamed(
  chunks: readonly string[],
  end: { readonly fails?: Error } = {},
): ReadableStream<Uint8Array> {
  const pending = [...chunks];

  return new ReadableStream<Uint8Array>(
    {
      pull: (controller) => {
        const next = pending.shift();

        if (next !== undefined) controller.enqueue(bytes(next));
        else if (end.fails === undefined) controller.close();
        else controller.error(end.fails);
      },
    },
    { highWaterMark: 0 },
  );
}

const limited = (
  maxSize = 1024,
  fields: Partial<AcceptUploadOptions> = {},
): AcceptUploadOptions => ({
  maxSize,
  ...fields,
});

describe("a stored object", () => {
  test("streams the body into `put` under the key and answers `201` with an empty body", async () => {
    const storage = holdingStorage();
    const response = await acceptUpload(
      storage,
      "uploads/report.txt",
      upload(streamed(["one ", "two"])),
      limited(),
    );

    expect(response.status).toBe(201);
    expect(await response.text()).toBe("");
    expect(text(storage.held.get("uploads/report.txt"))).toBe("one two");
  });

  test("carries the `etag` of `put` as a quoted strong `ETag`", async () => {
    const response = await acceptUpload(
      holdingStorage({ etag: "0123abcd" }),
      "a",
      upload(bytes("x")),
      limited(),
    );

    expect(response.headers.get("etag")).toBe('"0123abcd"');
  });

  test("carries no `ETag` where `put` hands over no `etag`", async () => {
    const response = await acceptUpload(
      holdingStorage({ etag: undefined }),
      "a",
      upload(bytes("x")),
      limited(),
    );

    expect(response.status).toBe(201);
    expect(response.headers.has("etag")).toBe(false);
  });

  test("answers `201` over an object the key held before", async () => {
    const storage = holdingStorage({ held: { a: "before" } });
    const response = await acceptUpload(storage, "a", upload(bytes("after")), limited());

    expect(response.status).toBe(201);
    expect(text(storage.held.get("a"))).toBe("after");
  });

  test("hands `request.signal` to `put`", async () => {
    const storage = holdingStorage();
    const sent = upload(bytes("x"));

    await acceptUpload(storage, "a", sent, limited());

    expect(storage.puts[0]?.options?.signal).toBe(sent.signal);
  });

  test("stores an empty object for a request whose `body` is `null`", async () => {
    const storage = holdingStorage();
    const response = await acceptUpload(storage, "a", upload(null), limited());

    expect(response.status).toBe(201);
    expect(storage.held.get("a")).toEqual(new Uint8Array());
  });

  test("the answer's headers are the caller's to change", async () => {
    const response = await acceptUpload(holdingStorage(), "a", upload(bytes("x")), limited());

    response.headers.set("location", "/files/a");

    expect(response.headers.get("location")).toBe("/files/a");
  });
});

describe("`objectStatOf`", () => {
  test("answers the `ObjectStat` `put` resolved with", async () => {
    const storage = holdingStorage();
    const response = await acceptUpload(
      storage,
      "uploads/report.txt",
      upload(bytes("abc")),
      limited(),
    );

    expect(objectStatOf(response)).toEqual(
      statOf({
        key: "uploads/report.txt",
        size: 3,
        etag: "e1",
        contentType: "application/octet-stream",
      }),
    );
  });

  test("answers `undefined` for a copy of the answer and for any other `Response`", async () => {
    const response = await acceptUpload(holdingStorage(), "a", upload(bytes("x")), limited());

    expect(objectStatOf(response.clone())).toBeUndefined();
    expect(objectStatOf(new Response(null, response))).toBeUndefined();
    expect(objectStatOf(new Response(null, { status: 201 }))).toBeUndefined();
  });

  test("answers `undefined` for a refusal", async () => {
    const response = await acceptUpload(
      holdingStorage(),
      "a",
      upload(null, { method: "POST" }),
      limited(),
    );

    expect(objectStatOf(response)).toBeUndefined();
  });
});

describe("any method but `PUT`", () => {
  test.each(["GET", "HEAD", "POST", "DELETE", "PATCH", "OPTIONS"])(
    "`%s` answers `405` with `Allow: PUT` and reaches no storage",
    async (method) => {
      const body = method === "GET" || method === "HEAD" ? null : bytes("x");
      const response = await acceptUpload(stubStorage(), "a", upload(body, { method }), limited());

      expect(response.status).toBe(405);
      expect(response.headers.get("allow")).toBe("PUT");
      expect(await response.text()).toBe("");
      expect(storageErrorOf(response)).toBeUndefined();
    },
  );
});

describe("`maxSize`", () => {
  test.each([
    ["-1", -1],
    ["1.5", 1.5],
    ["NaN", Number.NaN],
    ["-Infinity", Number.NEGATIVE_INFINITY],
    ['the string "1"', "1"],
    ["absent", undefined],
  ])(
    "%s, no non-negative integer and not `Infinity`, rejects with a `TypeError`",
    async (_, maxSize) => {
      const storage = holdingStorage();
      // oxlint-disable-next-line no-unsafe-type-assertion -- a caller's value, which no type holds back in JavaScript
      const options = { maxSize } as unknown as AcceptUploadOptions;

      await expect(acceptUpload(storage, "a", upload(bytes("x")), options)).rejects.toThrow(
        TypeError,
      );
      expect(storage.puts).toEqual([]);
    },
  );

  test("a `Content-Length` above it answers `413` before the body is read", async () => {
    const storage = holdingStorage();
    const sent = upload(streamed(["0123456789"]), { headers: { "content-length": "10" } });
    const response = await acceptUpload(storage, "a", sent, limited(9));

    expect(response.status).toBe(413);
    expect(await response.text()).toBe("");
    expect(storageErrorOf(response)).toBeUndefined();
    expect(sent.bodyUsed).toBe(false);
    expect(storage.puts).toEqual([]);
  });

  test("a body of exactly `maxSize` bytes is stored", async () => {
    const storage = holdingStorage();
    const response = await acceptUpload(
      storage,
      "a",
      upload(streamed(["01234", "56789"])),
      limited(10),
    );

    expect(response.status).toBe(201);
    expect(text(storage.held.get("a"))).toBe("0123456789");
  });

  test("a body without a length that passes it answers `413` and leaves the key as it was", async () => {
    const storage = holdingStorage({ held: { a: "before" } });
    const response = await acceptUpload(
      storage,
      "a",
      upload(streamed(["01234", "56789", "a"])),
      limited(10),
    );

    expect(response.status).toBe(413);
    expect(await response.text()).toBe("");
    expect(storageErrorOf(response)).toBeUndefined();
    expect(text(storage.held.get("a"))).toBe("before");
  });

  test("`Infinity` stores a body of any size", async () => {
    const storage = holdingStorage();
    const chunks = Array.from({ length: 64 }, () => "x".repeat(1024));
    const response = await acceptUpload(storage, "a", upload(streamed(chunks)), limited(Infinity));

    expect(response.status).toBe(201);
    expect(storage.held.get("a")?.byteLength).toBe(65536);
  });

  test("`0` stores an empty body and refuses one byte", async () => {
    const storage = holdingStorage();

    expect((await acceptUpload(storage, "a", upload(streamed([])), limited(0))).status).toBe(201);
    expect((await acceptUpload(storage, "b", upload(streamed(["x"])), limited(0))).status).toBe(
      413,
    );
    expect(storage.held.has("b")).toBe(false);
  });
});

describe("a body that contradicts its `Content-Length`", () => {
  test("ending short of it answers `400` and leaves the key as it was", async () => {
    const storage = holdingStorage({ held: { a: "before" } });
    const sent = upload(streamed(["01234"]), { headers: { "content-length": "10" } });
    const response = await acceptUpload(storage, "a", sent, limited());

    expect(response.status).toBe(400);
    expect(await response.text()).toBe("");
    expect(storageErrorOf(response)).toBeUndefined();
    expect(text(storage.held.get("a"))).toBe("before");
  });

  test("running past it answers `400` and leaves the key as it was", async () => {
    const storage = holdingStorage({ held: { a: "before" } });
    const sent = upload(streamed(["01234", "56789"]), { headers: { "content-length": "5" } });
    const response = await acceptUpload(storage, "a", sent, limited());

    expect(response.status).toBe(400);
    expect(text(storage.held.get("a"))).toBe("before");
  });

  test("running past it and past `maxSize` alike answers `400`, since it ran past the length first", async () => {
    const storage = holdingStorage();
    const sent = upload(streamed(["0123456789"]), { headers: { "content-length": "5" } });

    expect((await acceptUpload(storage, "a", sent, limited(8))).status).toBe(400);
  });

  test("a `null` body under a `Content-Length` other than `0` answers `400`", async () => {
    const storage = holdingStorage();
    const sent = upload(null, { headers: { "content-length": "5" } });

    expect((await acceptUpload(storage, "a", sent, limited())).status).toBe(400);
    expect(storage.held.has("a")).toBe(false);
  });

  test.each(["", "abc", "-1", "1.5", "5, 5"])(
    "a `Content-Length` of %j, no length at all, answers `400` before the body is read",
    async (length) => {
      const storage = holdingStorage();
      const sent = upload(streamed(["01234"]), { headers: { "content-length": length } });

      expect((await acceptUpload(storage, "a", sent, limited())).status).toBe(400);
      expect(sent.bodyUsed).toBe(false);
      expect(storage.puts).toEqual([]);
    },
  );

  test("matching it exactly is stored", async () => {
    const storage = holdingStorage();
    const sent = upload(streamed(["01234"]), { headers: { "content-length": "5" } });

    expect((await acceptUpload(storage, "a", sent, limited())).status).toBe(201);
    expect(text(storage.held.get("a"))).toBe("01234");
  });
});

describe("a body that fails while it is read", () => {
  test("answers `400` without a `StorageError` and leaves the key as it was", async () => {
    const storage = holdingStorage({ held: { a: "before" } });
    const sent = upload(streamed(["01234"], { fails: new Error("The connection was reset") }));
    const response = await acceptUpload(storage, "a", sent, limited());

    expect(response.status).toBe(400);
    expect(await response.text()).toBe("");
    expect(storageErrorOf(response)).toBeUndefined();
    expect(text(storage.held.get("a"))).toBe("before");
  });
});

describe("an abort while the body streams", () => {
  test("is thrown on, with no refusal standing in for the body `put` canceled", async () => {
    const storage = holdingStorage({ held: { a: "before" } });
    const aborting = new AbortController();
    // The body never ends, so the abort alone stops `put`, and the read it cuts short
    // ends the source before its `Content-Length`.
    const body = new ReadableStream<Uint8Array>({
      start: (opened) => opened.enqueue(bytes("01234")),
    });
    const sent = upload(body, { headers: { "content-length": "10" }, signal: aborting.signal });
    const answered = acceptUpload(storage, "a", sent, limited());

    await new Promise((resolve) => setTimeout(resolve, 0));
    aborting.abort();

    await expect(answered).rejects.toMatchObject({ name: "AbortError" });
    expect(text(storage.held.get("a"))).toBe("before");
  });
});

describe("the content type", () => {
  test("is `contentType` where it is given, over the request's `Content-Type`", async () => {
    const storage = holdingStorage();
    const sent = upload(bytes("x"), { headers: { "content-type": "text/html" } });

    await acceptUpload(storage, "a", sent, limited(1024, { contentType: "text/plain" }));

    expect(storage.puts[0]?.options?.contentType).toBe("text/plain");
  });

  test("is the request's `Content-Type` without `contentType`", async () => {
    const storage = holdingStorage();
    const sent = upload(bytes("x"), { headers: { "content-type": "image/png" } });

    await acceptUpload(storage, "a", sent, limited());

    expect(storage.puts[0]?.options?.contentType).toBe("image/png");
  });

  test("is left to the storage's default without either", async () => {
    const storage = holdingStorage();

    await acceptUpload(storage, "a", upload(bytes("x")), limited());

    expect(storage.puts[0]?.options?.contentType).toBeUndefined();
  });
});

describe("user metadata", () => {
  test("is `userMetadata` alone, never a request header", async () => {
    const storage = holdingStorage();
    const sent = upload(bytes("x"), { headers: { "x-amz-meta-a": "1", "x-ms-meta-a": "1" } });

    await acceptUpload(storage, "a", sent, limited(1024, { userMetadata: { owner: "7" } }));

    expect(storage.puts[0]?.options?.userMetadata).toEqual({ owner: "7" });
  });

  test("is none without `userMetadata`, whatever the request's headers say", async () => {
    const storage = holdingStorage();
    const sent = upload(bytes("x"), { headers: { "x-amz-meta-a": "1" } });

    await acceptUpload(storage, "a", sent, limited());

    expect(storage.puts[0]?.options?.userMetadata).toBeUndefined();
  });
});

describe("`Content-Encoding`", () => {
  test.each(["gzip", "br", "identity, gzip", "x-unknown"])(
    "`%s` answers `415` and reaches no storage",
    async (coding) => {
      const storage = holdingStorage();
      const sent = upload(bytes("x"), { headers: { "content-encoding": coding } });
      const response = await acceptUpload(storage, "a", sent, limited());

      expect(response.status).toBe(415);
      expect(await response.text()).toBe("");
      expect(storageErrorOf(response)).toBeUndefined();
      expect(storage.puts).toEqual([]);
    },
  );

  test.each(["identity", "Identity", ""])("`%s` is stored as it was sent", async (coding) => {
    const storage = holdingStorage();
    const sent = upload(bytes("x"), { headers: { "content-encoding": coding } });

    expect((await acceptUpload(storage, "a", sent, limited())).status).toBe(201);
  });
});

describe("a body already read", () => {
  test("rejects with a `TypeError` before `put` starts", async () => {
    const storage = holdingStorage();
    const sent = upload(bytes("x"));

    await sent.arrayBuffer();

    await expect(acceptUpload(storage, "a", sent, limited())).rejects.toThrow(TypeError);
    expect(storage.puts).toEqual([]);
  });
});

type Failure = Partial<StorageErrorFields> & Pick<StorageErrorFields, "code">;

/** A storage whose `put` rejects with `thrown`. */
const refusing = (thrown: unknown): Storage =>
  stubStorage({
    put: async () => {
      throw thrown;
    },
  });

describe("a `StorageError` from `put`", () => {
  test.each<{ row: string; fields: Failure; status: number }>([
    { row: "`InvalidKey`", fields: { code: "InvalidKey", key: "a/" }, status: 404 },
    { row: "`NotFound` with `key`", fields: { code: "NotFound", key: "a" }, status: 404 },
    { row: "`NotFound` without `key`", fields: { code: "NotFound" }, status: 500 },
    { row: "`NetworkError`", fields: { code: "NetworkError", retryable: true }, status: 503 },
    {
      row: "a retryable `ProviderError`",
      fields: { code: "ProviderError", retryable: true },
      status: 503,
    },
    { row: "`AccessDenied`", fields: { code: "AccessDenied" }, status: 500 },
    { row: "`Expired`", fields: { code: "Expired" }, status: 500 },
    {
      row: "`InvalidRequest` over the part limit",
      fields: { code: "InvalidRequest" },
      status: 500,
    },
  ])("$row answers $status with an empty body", async ({ fields, status }) => {
    const error = storageError({ operation: "put", ...fields });
    const response = await acceptUpload(refusing(error), "a", upload(bytes("x")), limited());

    expect(response.status).toBe(status);
    expect(await response.text()).toBe("");
    expect(storageErrorOf(response)).toBe(error);
    expect(objectStatOf(response)).toBeUndefined();
  });

  test("anything else thrown is thrown on, an `AbortError` among it", async () => {
    const thrown = new DOMException("The client went away", "AbortError");

    await expect(acceptUpload(refusing(thrown), "a", upload(bytes("x")), limited())).rejects.toBe(
      thrown,
    );
  });
});
