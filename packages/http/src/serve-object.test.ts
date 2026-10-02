import type { OperationOptions, Storage, StorageError, StorageErrorFields } from "@stowage/core";
import { afterEach, describe, expect, test, vi } from "vitest";

import { serveObject, type ServeObjectOptions, storageErrorOf } from "./index.ts";
import { statOf, storageError, storedObject, streamOf, stubStorage } from "./stubs.ts";

const request = (method: string, init: RequestInit = {}): Request =>
  new Request("http://localhost/files/report", { method, ...init });

/** A storage holding one object, under whatever key it is asked for. */
const holding = (
  fields: { capabilities?: Storage["capabilities"]; etag?: string } = {},
): Storage => {
  const stat = statOf("etag" in fields ? { etag: fields.etag } : {});

  return stubStorage({
    capabilities: fields.capabilities,
    get: async (key) => storedObject({ ...stat, key }, streamOf("body")),
    stat: async (key) => ({ ...stat, key }),
  });
};

const serve = async (
  method: string,
  options?: ServeObjectOptions,
  storage: Storage = holding(),
  key = "docs/report.pdf",
): Promise<Response> => await serveObject(storage, key, request(method), options);

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe("`GET`", () => {
  test("answers `200` with the stream of `get` as its body", async () => {
    const body = streamOf("the stored bytes");
    const storage = stubStorage({ get: async () => storedObject(statOf(), body) });

    const response = await serveObject(storage, "docs/report.pdf", request("GET"));

    expect(response.status).toBe(200);
    expect(response.body).toBe(body);
    expect(await response.text()).toBe("the stored bytes");
  });

  test("carries no `Content-Length`", async () => {
    expect((await serve("GET")).headers.has("content-length")).toBe(false);
  });

  test("hands `request.signal` to `get`", async () => {
    const signals: (AbortSignal | undefined)[] = [];
    const storage = stubStorage({
      get: async (_key, options) => {
        signals.push(options?.signal);

        return storedObject(statOf());
      },
    });
    const sent = request("GET");

    await serveObject(storage, "docs/report.pdf", sent);

    expect(signals).toEqual([sent.signal]);
  });
});

describe("`HEAD`", () => {
  test("answers `200` from `stat` with the headers of the `GET` and no body", async () => {
    const storage = stubStorage({
      stat: async () => statOf(),
      get: async () => {
        throw new Error("`HEAD` reads no body");
      },
    });

    const head = await serveObject(storage, "docs/report.pdf", request("HEAD"));
    const get = await serve("GET");

    expect(head.status).toBe(200);
    expect(head.body).toBeNull();
    expect([...head.headers]).toEqual([...get.headers]);
    expect(head.headers.has("content-length")).toBe(false);
  });

  test("hands `request.signal` to `stat`", async () => {
    const signals: (AbortSignal | undefined)[] = [];
    const storage = stubStorage({
      stat: async (_key, options?: OperationOptions) => {
        signals.push(options?.signal);

        return statOf();
      },
    });
    const sent = request("HEAD");

    await serveObject(storage, "docs/report.pdf", sent);

    expect(signals).toEqual([sent.signal]);
  });
});

describe("any other method", () => {
  test.each(["POST", "PUT", "DELETE", "PATCH", "OPTIONS"])(
    "`%s` answers `405` with `Allow: GET, HEAD` and reaches no storage",
    async (method) => {
      const response = await serveObject(stubStorage(), "docs/report.pdf", request(method));

      expect(response.status).toBe(405);
      expect(response.headers.get("allow")).toBe("GET, HEAD");
      expect(await response.text()).toBe("");
      expect(storageErrorOf(response)).toBeUndefined();
    },
  );
});

describe("the headers of spec 10.3", () => {
  test("`Content-Type` is the stored one", async () => {
    expect((await serve("GET")).headers.get("content-type")).toBe("application/pdf");
  });

  test("`X-Content-Type-Options` is `nosniff`", async () => {
    expect((await serve("GET")).headers.get("x-content-type-options")).toBe("nosniff");
  });

  test("`Cache-Control` is `private, no-cache`, which `cacheControl` replaces", async () => {
    expect((await serve("GET")).headers.get("cache-control")).toBe("private, no-cache");
    expect(
      (await serve("GET", { cacheControl: "public, max-age=60" })).headers.get("cache-control"),
    ).toBe("public, max-age=60");
  });

  test("`ETag` is the `etag` quoted as a strong tag", async () => {
    expect((await serve("GET")).headers.get("etag")).toBe('"0123abcd"');
  });

  test("a storage handing over no `etag` gets no `ETag`", async () => {
    const storage = holding({ etag: undefined });

    expect((await serve("GET", {}, storage)).headers.has("etag")).toBe(false);
    expect((await serve("HEAD", {}, storage)).headers.has("etag")).toBe(false);
  });

  test("`Last-Modified` is `lastModified` at whole seconds", async () => {
    expect((await serve("GET")).headers.get("last-modified")).toBe("Tue, 01 Sep 2026 10:20:30 GMT");
  });

  test("`Last-Modified` is the response's date where `lastModified` is later", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-09-01T10:20:29.900Z"));

    expect((await serve("GET")).headers.get("last-modified")).toBe("Tue, 01 Sep 2026 10:20:29 GMT");
  });

  test("`Accept-Ranges: bytes` is sent where the storage declares `rangeReads`", async () => {
    const declaring = holding({ capabilities: ["rangeReads"] });

    expect((await serve("GET", {}, declaring)).headers.get("accept-ranges")).toBe("bytes");
    expect((await serve("HEAD", {}, declaring)).headers.get("accept-ranges")).toBe("bytes");
    expect((await serve("GET")).headers.has("accept-ranges")).toBe(false);
  });
});

const disposition = async (key: string, options?: ServeObjectOptions): Promise<string | null> =>
  (await serve("GET", options, holding(), key)).headers.get("content-disposition");

describe("`Content-Disposition`", () => {
  test("is an attachment named after the key's last segment by default", async () => {
    expect(await disposition("docs/2026/report.pdf")).toBe(
      `attachment; filename="report.pdf"; filename*=UTF-8''report.pdf`,
    );
  });

  test("is named `filename` where it is given", async () => {
    expect(await disposition("docs/2026/report.pdf", { filename: "Q3.pdf" })).toBe(
      `attachment; filename="Q3.pdf"; filename*=UTF-8''Q3.pdf`,
    );
  });

  test("carries the fallback and the RFC 8187 form of spec 10.3's example", async () => {
    expect(await disposition("docs/résumé 100%.pdf")).toBe(
      `attachment; filename="r_sum_ 100_.pdf"; filename*=UTF-8''r%C3%A9sum%C3%A9%20100%25.pdf`,
    );
  });

  test("replaces a quote and a backslash in the fallback and encodes both", async () => {
    expect(await disposition(`a"b\\c.txt`)).toBe(
      `attachment; filename="a_b_c.txt"; filename*=UTF-8''a%22b%5Cc.txt`,
    );
  });

  test("leaves RFC 8187's `attr-char` unencoded", async () => {
    expect(await disposition("!#$&+-.^_`|~09AZaz")).toBe(
      `attachment; filename="!#$&+-.^_\`|~09AZaz"; filename*=UTF-8''!#$&+-.^_\`|~09AZaz`,
    );
  });

  test("encodes a character outside the BMP from its UTF-8 bytes", async () => {
    expect(await disposition("😀.txt")).toBe(
      `attachment; filename="_.txt"; filename*=UTF-8''%F0%9F%98%80.txt`,
    );
  });

  test("is `attachment` alone for a key ending in `/`", async () => {
    expect(await disposition("docs/")).toBe("attachment");
  });

  test("follows `inline` with the same parameters", async () => {
    expect(await disposition("docs/report.pdf", { disposition: "inline" })).toBe(
      `inline; filename="report.pdf"; filename*=UTF-8''report.pdf`,
    );
    expect(await disposition("docs/", { disposition: "inline" })).toBe("inline");
  });
});

const sixteenBytes = "0123456789abcdef";

/**
 * A storage holding one 16-byte object and honoring `range` as spec 4.3 has it, which
 * records every call it receives in `calls`.
 */
const ranging = (
  fields: { capabilities?: Storage["capabilities"]; get?: Storage["get"] } = {},
): { storage: Storage; calls: string[] } => {
  const calls: string[] = [];
  const stat = statOf({ size: sixteenBytes.length });

  const storage = stubStorage({
    capabilities: fields.capabilities ?? ["rangeReads"],
    get: async (key, options) => {
      const range = options?.range;

      calls.push(range === undefined ? "get" : `get ${range.start}-${range.end ?? ""}`);

      if (fields.get !== undefined) return await fields.get(key, options);
      if (range === undefined) return storedObject(stat, streamOf(sixteenBytes));
      if (range.start >= stat.size) throw storageError({ code: "InvalidRequest", key });

      const end = Math.min(range.end ?? stat.size - 1, stat.size - 1);

      return storedObject(stat, streamOf(sixteenBytes.slice(range.start, end + 1)));
    },
    stat: async () => {
      calls.push("stat");

      return stat;
    },
  });

  return { storage, calls };
};

const ranged = async (storage: Storage, range: string, method = "GET"): Promise<Response> =>
  await serveObject(storage, "docs/report.pdf", request(method, { headers: { range } }));

describe("a `Range` on a storage declaring `rangeReads`", () => {
  test("of one span is `206` with the bytes, `Content-Range` and `Content-Length`", async () => {
    const { storage, calls } = ranging();
    const response = await ranged(storage, "bytes=2-5");

    expect(response.status).toBe(206);
    expect(await response.text()).toBe("2345");
    expect(response.headers.get("content-range")).toBe("bytes 2-5/16");
    expect(response.headers.get("content-length")).toBe("4");
    expect(calls).toEqual(["get 2-5"]);
  });

  test("carries the headers of a `200` beside its own", async () => {
    const { storage } = ranging();
    const whole = [...(await serve("GET", {}, storage)).headers];
    const partial = [...(await ranged(storage, "bytes=2-5")).headers].filter(
      ([name]) => name !== "content-range" && name !== "content-length",
    );

    expect(partial).toEqual(whole);
  });

  test.each([
    ["bytes=4-", "456789abcdef", "bytes 4-15/16", "12"],
    ["bytes=2-999", "23456789abcdef", "bytes 2-15/16", "14"],
    ["bytes=15-15", "f", "bytes 15-15/16", "1"],
  ])("`%s` is `206` up to the last byte", async (range, body, contentRange, length) => {
    const response = await ranged(ranging().storage, range);

    expect(response.status).toBe(206);
    expect(await response.text()).toBe(body);
    expect(response.headers.get("content-range")).toBe(contentRange);
    expect(response.headers.get("content-length")).toBe(length);
  });

  test("of a suffix is `206` with the last bytes, after a `stat`", async () => {
    const { storage, calls } = ranging();
    const response = await ranged(storage, "bytes=-3");

    expect(response.status).toBe(206);
    expect(await response.text()).toBe("def");
    expect(response.headers.get("content-range")).toBe("bytes 13-15/16");
    expect(response.headers.get("content-length")).toBe("3");
    expect(calls).toEqual(["stat", "get 13-15"]);
  });

  test("of a suffix longer than the object is `206` with the whole object", async () => {
    const response = await ranged(ranging().storage, "bytes=-20");

    expect(response.status).toBe(206);
    expect(await response.text()).toBe(sixteenBytes);
    expect(response.headers.get("content-range")).toBe("bytes 0-15/16");
  });

  test("starting at the size is `416` with the size of a `stat` after the failed `get`", async () => {
    const { storage, calls } = ranging();
    const response = await ranged(storage, "bytes=16-");

    expect(response.status).toBe(416);
    expect(response.headers.get("content-range")).toBe("bytes */16");
    expect(await response.text()).toBe("");
    expect(storageErrorOf(response)?.code).toBe("InvalidRequest");
    expect(calls).toEqual(["get 16-", "stat"]);
  });

  test("of an empty suffix is `416` without a `get`", async () => {
    const { storage, calls } = ranging();
    const response = await ranged(storage, "bytes=-0");

    expect(response.status).toBe(416);
    expect(response.headers.get("content-range")).toBe("bytes */16");
    expect(storageErrorOf(response)).toBeUndefined();
    expect(calls).toEqual(["stat"]);
  });

  test("of a suffix on an empty object is `200` with the whole object", async () => {
    const empty = statOf({ size: 0 });
    const storage = stubStorage({
      capabilities: ["rangeReads"],
      stat: async () => empty,
      get: async (_key, options) => {
        if (options?.range !== undefined) throw new Error("No range lies inside no bytes");

        return storedObject(empty, streamOf(""));
      },
    });
    const response = await ranged(storage, "bytes=-3");

    expect(response.status).toBe(200);
    expect(response.headers.has("content-range")).toBe(false);
  });

  test("with a position beyond a safe integer is held at the largest one", async () => {
    const whole = await ranged(ranging().storage, "bytes=0-99999999999999999999");
    const beyond = await ranged(ranging().storage, "bytes=99999999999999999999-");

    expect(whole.status).toBe(206);
    expect(whole.headers.get("content-range")).toBe("bytes 0-15/16");
    expect(beyond.status).toBe(416);
  });

  test("a failing `stat` after the failed `get` answers its own error", async () => {
    const gone = storageError({ code: "NotFound", key: "docs/report.pdf" });
    const storage = stubStorage({
      capabilities: ["rangeReads"],
      get: async () => {
        throw storageError({ code: "InvalidRequest" });
      },
      stat: async () => {
        throw gone;
      },
    });
    const response = await ranged(storage, "bytes=16-");

    expect(response.status).toBe(404);
    expect(storageErrorOf(response)).toBe(gone);
  });

  test("of another case of `bytes` is honored", async () => {
    expect((await ranged(ranging().storage, "Bytes=2-5")).status).toBe(206);
  });
});

describe("a `Range` spec 10.3 ignores", () => {
  test.each([
    ["several ranges", "bytes=0-1,3-4"],
    ["another unit", "items=0-1"],
    ["a malformed header", "bytes=x"],
    ["no position at all", "bytes=-"],
    ["a last position before the first", "bytes=5-2"],
    ["a space inside the range", "bytes=2 -5"],
  ])("as %s answers `200` with the whole object from one `get`", async (_, range) => {
    const { storage, calls } = ranging();
    const response = await ranged(storage, range);

    expect(response.status).toBe(200);
    expect(await response.text()).toBe(sixteenBytes);
    expect(response.headers.has("content-range")).toBe(false);
    expect(calls).toEqual(["get"]);
  });

  test("on a storage without `rangeReads` answers `200` with the whole object", async () => {
    for (const range of ["bytes=2-5", "bytes=-3", "bytes=16-"]) {
      const { storage, calls } = ranging({ capabilities: [] });
      // oxlint-disable-next-line no-await-in-loop -- one request after the other
      const response = await ranged(storage, range);

      expect(response.status).toBe(200);
      expect(calls).toEqual(["get"]);
    }
  });

  test("on a `HEAD` answers `200` from `stat` alone", async () => {
    const { storage, calls } = ranging();
    const response = await ranged(storage, "bytes=2-5", "HEAD");

    expect(response.status).toBe(200);
    expect(response.headers.has("content-range")).toBe(false);
    expect(calls).toEqual(["stat"]);
  });
});

/** A storage refusing every range with `refusal`, and serving the whole object. */
const refusingRanges = (refusal: StorageError): { storage: Storage; calls: string[] } => {
  const whole = ranging().storage;

  return ranging({
    get: async (key, options) => {
      if (options?.range !== undefined) throw refusal;

      return await whole.get(key, options);
    },
  });
};

describe("a ranged `get` rejecting with a `ProviderError`", () => {
  test("not retryable is followed by one whole `get`, answered `200`", async () => {
    const { storage, calls } = refusingRanges(storageError({ code: "ProviderError" }));
    const response = await ranged(storage, "bytes=2-5");

    expect(response.status).toBe(200);
    expect(await response.text()).toBe(sixteenBytes);
    expect(response.headers.has("content-range")).toBe(false);
    expect(response.headers.has("content-length")).toBe(false);
    expect(calls).toEqual(["get 2-5", "get"]);
  });

  test("not retryable on a suffix is followed by one whole `get`", async () => {
    const { storage, calls } = refusingRanges(storageError({ code: "ProviderError" }));
    const response = await ranged(storage, "bytes=-3");

    expect(response.status).toBe(200);
    expect(calls).toEqual(["stat", "get 13-15", "get"]);
  });

  test("not retryable answers the error of the whole `get` where that fails too", async () => {
    const second = storageError({ code: "ProviderError" });
    const { storage, calls } = ranging({
      get: async (_key, options) => {
        throw options?.range === undefined ? second : storageError({ code: "ProviderError" });
      },
    });
    const response = await ranged(storage, "bytes=2-5");

    expect(response.status).toBe(500);
    expect(storageErrorOf(response)).toBe(second);
    expect(calls).toEqual(["get 2-5", "get"]);
  });

  test("retryable is `503` without a second `get`", async () => {
    const refusal = storageError({ code: "ProviderError", retryable: true });
    const { storage, calls } = refusingRanges(refusal);
    const response = await ranged(storage, "bytes=2-5");

    expect(response.status).toBe(503);
    expect(storageErrorOf(response)).toBe(refusal);
    expect(calls).toEqual(["get 2-5"]);
  });
});

type Failure = Partial<StorageErrorFields> & Pick<StorageErrorFields, "code">;

/** Spec 10.2's table, row by row, with a `StorageError` of each code from `get` and `stat`. */
const statuses: readonly { row: string; fields: Failure; status: number }[] = [
  {
    row: "`NotFound` with `key`",
    fields: { code: "NotFound", key: "docs/report.pdf" },
    status: 404,
  },
  { row: "`InvalidKey`", fields: { code: "InvalidKey", key: "a//b" }, status: 404 },
  { row: "`NotFound` without `key`", fields: { code: "NotFound" }, status: 500 },
  { row: "`NetworkError`", fields: { code: "NetworkError", retryable: true }, status: 503 },
  {
    row: "a retryable `ProviderError`",
    fields: { code: "ProviderError", retryable: true },
    status: 503,
  },
  { row: "a `ProviderError` not retryable", fields: { code: "ProviderError" }, status: 500 },
  { row: "`AccessDenied`", fields: { code: "AccessDenied" }, status: 500 },
  { row: "`InvalidCredentials`", fields: { code: "InvalidCredentials" }, status: 500 },
  { row: "`Expired`", fields: { code: "Expired" }, status: 500 },
  { row: "`InvalidRequest` from a whole `get`", fields: { code: "InvalidRequest" }, status: 500 },
  { row: "`InvalidOption`", fields: { code: "InvalidOption" }, status: 500 },
  {
    row: "`Unsupported`",
    fields: { code: "Unsupported", capability: "rangeReads" },
    status: 500,
  },
];

const failing = (fields: Failure): { error: StorageError; storage: Storage } => {
  const error = storageError(fields);
  const reject = async (): Promise<never> => {
    throw error;
  };

  return { error, storage: stubStorage({ get: reject, stat: reject }) };
};

describe("a `StorageError`", () => {
  test.each(statuses)("$row answers `GET` and `HEAD` with $status", async ({ fields, status }) => {
    const { error, storage } = failing(fields);

    for (const method of ["GET", "HEAD"]) {
      // oxlint-disable-next-line no-await-in-loop -- one method after the other
      const response = await serveObject(storage, "docs/report.pdf", request(method));

      expect(response.status).toBe(status);
      expect(storageErrorOf(response)).toBe(error);
    }
  });

  test("answers with an empty body and no `Retry-After`", async () => {
    const { storage } = failing({ code: "NetworkError", retryable: true });
    const response = await serveObject(storage, "docs/report.pdf", request("GET"));

    expect(await response.text()).toBe("");
    expect(response.headers.has("retry-after")).toBe(false);
  });
});

const failed = async (): Promise<Response> =>
  await serveObject(
    stubStorage({
      get: async () => {
        throw storageError({ code: "NotFound", key: "docs/report.pdf" });
      },
    }),
    "docs/report.pdf",
    request("GET"),
  );

describe("`storageErrorOf`", () => {
  test("answers `undefined` for a `Response` the layer did not build from an error", async () => {
    expect(storageErrorOf(new Response(null, { status: 404 }))).toBeUndefined();
    expect(storageErrorOf(await serve("GET"))).toBeUndefined();
  });

  test("answers `undefined` for a copy of an answer built from an error", async () => {
    const response = await failed();

    expect(storageErrorOf(response.clone())).toBeUndefined();
    expect(storageErrorOf(new Response(response.body, response))).toBeUndefined();
  });

  test("holds where the global `Response` is a subclass", async () => {
    class ServerResponse extends Response {}

    vi.stubGlobal("Response", ServerResponse);

    const response = await failed();

    expect(response).toBeInstanceOf(ServerResponse);
    expect(storageErrorOf(response)?.code).toBe("NotFound");
  });
});

describe("anything thrown that is not a `StorageError`", () => {
  test.each([
    ["an `AbortError`", new DOMException("The request was aborted", "AbortError")],
    ["a programmer error", new TypeError("storage.get is not a function")],
  ])("is %s thrown on", async (_, thrown) => {
    const storage = stubStorage({
      get: async () => {
        throw thrown;
      },
      stat: async () => {
        throw thrown;
      },
    });

    await expect(serveObject(storage, "docs/report.pdf", request("GET"))).rejects.toBe(thrown);
    await expect(serveObject(storage, "docs/report.pdf", request("HEAD"))).rejects.toBe(thrown);
  });
});

test("every answer has headers the caller may change", async () => {
  const notFound = stubStorage({
    get: async () => {
      throw storageError({ code: "NotFound", key: "docs/report.pdf" });
    },
  });
  const answers = [
    await serve("GET"),
    await serve("HEAD"),
    await serve("POST"),
    await serveObject(notFound, "docs/report.pdf", request("GET")),
  ];

  for (const response of answers) {
    response.headers.set("access-control-allow-origin", "*");

    expect(response.headers.get("access-control-allow-origin")).toBe("*");
  }
});
