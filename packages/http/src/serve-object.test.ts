import type {
  ObjectStat,
  OperationOptions,
  Storage,
  StorageError,
  StorageErrorFields,
} from "@stowage/core";
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

  test("carries `Content-Length` as the `size` of the `stat` of `get`", async () => {
    const storage = stubStorage({
      get: async () => storedObject(statOf({ size: 16 }), streamOf("the stored bytes")),
    });

    const response = await serveObject(storage, "docs/report.pdf", request("GET"));

    expect(response.headers.get("content-length")).toBe("16");
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
    expect(head.headers.get("content-length")).toBe("4");
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

  // Bun and Deno cache the `Date` they write by up to a second, so one the server added could
  // lie before the `Last-Modified` the layer capped at its own clock.
  test.each(["GET", "HEAD"])(
    "`Date` on `%s` is the moment `Last-Modified` was capped at",
    async (method) => {
      vi.useFakeTimers({ toFake: ["Date"] });
      vi.setSystemTime(new Date("2026-09-01T10:20:29.900Z"));

      const { headers } = await serve(method);

      expect(headers.get("date")).toBe("Tue, 01 Sep 2026 10:20:29 GMT");
      expect(headers.get("last-modified")).toBe(headers.get("date"));
    },
  );

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
const rangingStorage = (
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

const serveRanged = async (storage: Storage, range: string, method = "GET"): Promise<Response> =>
  await serveObject(storage, "docs/report.pdf", request(method, { headers: { range } }));

describe("a `Range` on a storage declaring `rangeReads`", () => {
  test("of one range is `206` with the bytes, `Content-Range` and `Content-Length`", async () => {
    const { storage, calls } = rangingStorage();
    const response = await serveRanged(storage, "bytes=2-5");

    expect(response.status).toBe(206);
    expect(await response.text()).toBe("2345");
    expect(response.headers.get("content-range")).toBe("bytes 2-5/16");
    expect(response.headers.get("content-length")).toBe("4");
    expect(calls).toEqual(["get 2-5"]);
  });

  test("carries the headers of a `200` beside its own", async () => {
    const { storage } = rangingStorage();
    const whole = [...(await serve("GET", {}, storage)).headers].filter(
      ([name]) => name !== "content-length",
    );
    const partial = [...(await serveRanged(storage, "bytes=2-5")).headers].filter(
      ([name]) => name !== "content-range" && name !== "content-length",
    );

    expect(partial).toEqual(whole);
  });

  test.each([
    ["bytes=4-", "456789abcdef", "bytes 4-15/16", "12"],
    ["bytes=2-999", "23456789abcdef", "bytes 2-15/16", "14"],
    ["bytes=15-15", "f", "bytes 15-15/16", "1"],
  ])("`%s` is `206` up to the last byte", async (range, body, contentRange, length) => {
    const response = await serveRanged(rangingStorage().storage, range);

    expect(response.status).toBe(206);
    expect(await response.text()).toBe(body);
    expect(response.headers.get("content-range")).toBe(contentRange);
    expect(response.headers.get("content-length")).toBe(length);
  });

  test("of a suffix is `206` with the last bytes, after a `stat`", async () => {
    const { storage, calls } = rangingStorage();
    const response = await serveRanged(storage, "bytes=-3");

    expect(response.status).toBe(206);
    expect(await response.text()).toBe("def");
    expect(response.headers.get("content-range")).toBe("bytes 13-15/16");
    expect(response.headers.get("content-length")).toBe("3");
    expect(calls).toEqual(["stat", "get 13-15"]);
  });

  test("of a suffix longer than the object is `206` with the whole object", async () => {
    const response = await serveRanged(rangingStorage().storage, "bytes=-20");

    expect(response.status).toBe(206);
    expect(await response.text()).toBe(sixteenBytes);
    expect(response.headers.get("content-range")).toBe("bytes 0-15/16");
  });

  test("starting at the size is `416` with the size of a `stat` after the failed `get`", async () => {
    const { storage, calls } = rangingStorage();
    const response = await serveRanged(storage, "bytes=16-");

    expect(response.status).toBe(416);
    expect(response.headers.get("content-range")).toBe("bytes */16");
    expect(await response.text()).toBe("");
    expect(storageErrorOf(response)?.code).toBe("InvalidRequest");
    expect(calls).toEqual(["get 16-", "stat"]);
  });

  test("of an empty suffix is `416` without a `get`", async () => {
    const { storage, calls } = rangingStorage();
    const response = await serveRanged(storage, "bytes=-0");

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
    const response = await serveRanged(storage, "bytes=-3");

    expect(response.status).toBe(200);
    expect(response.headers.has("content-range")).toBe(false);
  });

  test("with a position beyond a safe integer is held at the largest one", async () => {
    const whole = await serveRanged(rangingStorage().storage, "bytes=0-99999999999999999999");
    const beyond = await serveRanged(rangingStorage().storage, "bytes=99999999999999999999-");

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
    const response = await serveRanged(storage, "bytes=16-");

    expect(response.status).toBe(404);
    expect(storageErrorOf(response)).toBe(gone);
  });

  test("of another case of `bytes` is honored", async () => {
    expect((await serveRanged(rangingStorage().storage, "Bytes=2-5")).status).toBe(206);
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
    const { storage, calls } = rangingStorage();
    const response = await serveRanged(storage, range);

    expect(response.status).toBe(200);
    expect(await response.text()).toBe(sixteenBytes);
    expect(response.headers.has("content-range")).toBe(false);
    expect(calls).toEqual(["get"]);
  });

  test("on a storage without `rangeReads` answers `200` with the whole object", async () => {
    for (const range of ["bytes=2-5", "bytes=-3", "bytes=16-"]) {
      const { storage, calls } = rangingStorage({ capabilities: [] });
      // oxlint-disable-next-line no-await-in-loop -- one request after the other
      const response = await serveRanged(storage, range);

      expect(response.status).toBe(200);
      expect(calls).toEqual(["get"]);
    }
  });

  test("on a `HEAD` answers `200` from `stat` alone", async () => {
    const { storage, calls } = rangingStorage();
    const response = await serveRanged(storage, "bytes=2-5", "HEAD");

    expect(response.status).toBe(200);
    expect(response.headers.has("content-range")).toBe(false);
    expect(calls).toEqual(["stat"]);
  });
});

/** A storage refusing every range with `refusal`, and serving the whole object. */
const refusingRanges = (refusal: StorageError): { storage: Storage; calls: string[] } => {
  const whole = rangingStorage().storage;

  return rangingStorage({
    get: async (key, options) => {
      if (options?.range !== undefined) throw refusal;

      return await whole.get(key, options);
    },
  });
};

describe("a ranged `get` rejecting with a `ProviderError`", () => {
  test("not retryable is followed by one whole `get`, answered `200`", async () => {
    const { storage, calls } = refusingRanges(storageError({ code: "ProviderError" }));
    const response = await serveRanged(storage, "bytes=2-5");

    expect(response.status).toBe(200);
    expect(await response.text()).toBe(sixteenBytes);
    expect(response.headers.has("content-range")).toBe(false);
    expect(calls).toEqual(["get 2-5", "get"]);
  });

  test("not retryable on a suffix is followed by one whole `get`", async () => {
    const { storage, calls } = refusingRanges(storageError({ code: "ProviderError" }));
    const response = await serveRanged(storage, "bytes=-3");

    expect(response.status).toBe(200);
    expect(calls).toEqual(["stat", "get 13-15", "get"]);
  });

  test("not retryable answers the error of the whole `get` where that fails too", async () => {
    const second = storageError({ code: "ProviderError" });
    const { storage, calls } = rangingStorage({
      get: async (_key, options) => {
        throw options?.range === undefined ? second : storageError({ code: "ProviderError" });
      },
    });
    const response = await serveRanged(storage, "bytes=2-5");

    expect(response.status).toBe(500);
    expect(storageErrorOf(response)).toBe(second);
    expect(calls).toEqual(["get 2-5", "get"]);
  });

  test("retryable is `503` without a second `get`", async () => {
    const refusal = storageError({ code: "ProviderError", retryable: true });
    const { storage, calls } = refusingRanges(refusal);
    const response = await serveRanged(storage, "bytes=2-5");

    expect(response.status).toBe(503);
    expect(storageErrorOf(response)).toBe(refusal);
    expect(calls).toEqual(["get 2-5"]);
  });
});

/**
 * A storage holding one object stored with `Content-Encoding: gzip`, refusing every range of
 * it as spec 4.3 has it and handing it over whole, which records every call in `calls`.
 */
const codedStorage = (): { storage: Storage; calls: string[] } => {
  const calls: string[] = [];
  const stat = statOf({ size: sixteenBytes.length, contentEncoding: "gzip" });
  const storage = stubStorage({
    capabilities: ["rangeReads"],
    get: async (_key, options) => {
      const range = options?.range;

      calls.push(range === undefined ? "get" : `get ${range.start}-${range.end ?? ""}`);

      if (range !== undefined) throw storageError({ code: "ProviderError" });

      return storedObject(stat, streamOf(sixteenBytes));
    },
    stat: async () => {
      calls.push("stat");

      return stat;
    },
  });

  return { storage, calls };
};

describe("an object stored with a content coding", () => {
  test.each(["GET", "HEAD"])(
    "is answered `200` to `%s` without `Content-Length`, `Content-Encoding` or `Accept-Ranges`",
    async (method) => {
      const response = await serve(method, {}, codedStorage().storage);

      expect(response.status).toBe(200);
      expect(response.headers.has("content-length")).toBe(false);
      expect(response.headers.has("content-encoding")).toBe(false);
      expect(response.headers.has("accept-ranges")).toBe(false);
    },
  );

  test("has a range without a `stat` first followed by one whole `get`", async () => {
    const { storage, calls } = codedStorage();
    const response = await serveRanged(storage, "bytes=2-5");

    expect(response.status).toBe(200);
    expect(await response.text()).toBe(sixteenBytes);
    expect(response.headers.has("content-length")).toBe(false);
    expect(response.headers.has("accept-ranges")).toBe(false);
    expect(calls).toEqual(["get 2-5", "get"]);
  });

  test.each([
    ["a suffix", { range: "bytes=-3" }],
    ["an empty suffix", { range: "bytes=-0" }],
    ["a range beside a precondition that holds", { range: "bytes=2-5", "if-match": "*" }],
    [
      "a range beside the strong `ETag` as `If-Range`",
      { range: "bytes=2-5", "if-range": '"0123abcd"' },
    ],
  ])("has %s ignored after the `stat`, answered `200` from one whole `get`", async (_, headers) => {
    const { storage, calls } = codedStorage();
    const response = await serveConditional(headers, storage);

    expect(response.status).toBe(200);
    expect(await response.text()).toBe(sixteenBytes);
    expect(response.headers.has("content-range")).toBe(false);
    expect(response.headers.has("content-length")).toBe(false);
    expect(calls).toEqual(["stat", "get"]);
  });
});

/** A `GET` of the object of `rangingStorage`, whose `etag` is `0123abcd`, with `headers`. */
const serveConditional = async (
  headers: Record<string, string>,
  storage: Storage = rangingStorage().storage,
  method = "GET",
): Promise<Response> => await serveObject(storage, "docs/report.pdf", request(method, { headers }));

describe("`If-None-Match`", () => {
  test("with the `ETag` is `304` with the headers of the `200` but `Content-Length`, from `stat` alone", async () => {
    const { storage, calls } = rangingStorage();
    const whole = [...(await serve("GET", {}, storage)).headers].filter(
      ([name]) => name !== "content-length",
    );
    const response = await serveConditional({ "if-none-match": '"0123abcd"' }, storage);

    expect(response.status).toBe(304);
    expect(await response.text()).toBe("");
    expect([...response.headers]).toEqual(whole);
    expect(calls).toEqual(["get", "stat"]);
  });

  test.each([
    ["the `ETag` as weak", 'W/"0123abcd"'],
    ["a list holding the `ETag`", '"other", W/"0123abcd"'],
    ["`*`", "*"],
  ])("with %s is `304`", async (_, field) => {
    expect((await serveConditional({ "if-none-match": field })).status).toBe(304);
  });

  test("with another tag is `200` from `stat` and one `get`", async () => {
    const { storage, calls } = rangingStorage();
    const response = await serveConditional({ "if-none-match": '"other", "0123abcd-1"' }, storage);

    expect(response.status).toBe(200);
    expect(await response.text()).toBe(sixteenBytes);
    expect(calls).toEqual(["stat", "get"]);
  });

  test("without an `etag` holds for any tag and fails for `*` alone", async () => {
    const storage = holding({ etag: undefined });

    expect((await serveConditional({ "if-none-match": '"0123abcd"' }, storage)).status).toBe(200);
    expect((await serveConditional({ "if-none-match": "*" }, storage)).status).toBe(304);
  });
});

describe("`If-Match`", () => {
  test.each([
    ["the `ETag`", '"0123abcd"'],
    ["a list holding the `ETag`", '"other", "0123abcd"'],
    ["`*`", "*"],
  ])("with %s is `200`", async (_, field) => {
    const response = await serveConditional({ "if-match": field });

    expect(response.status).toBe(200);
    expect(await response.text()).toBe(sixteenBytes);
  });

  test.each([
    ["another tag", '"other"'],
    ["the `ETag` as weak", 'W/"0123abcd"'],
    ["a field that is no list of tags", "0123abcd"],
  ])("with %s is `412` with an empty body, from `stat` alone", async (_, field) => {
    const { storage, calls } = rangingStorage();
    const response = await serveConditional({ "if-match": field }, storage);

    expect(response.status).toBe(412);
    expect(await response.text()).toBe("");
    expect([...response.headers]).toEqual([]);
    expect(storageErrorOf(response)).toBeUndefined();
    expect(calls).toEqual(["stat"]);
  });

  test("without an `etag` fails for any tag and holds for `*` alone", async () => {
    const storage = holding({ etag: undefined });

    expect((await serveConditional({ "if-match": '"0123abcd"' }, storage)).status).toBe(412);
    expect((await serveConditional({ "if-match": "*" }, storage)).status).toBe(200);
  });

  test("is evaluated before `If-None-Match`", async () => {
    const response = await serveConditional({
      "if-match": '"other"',
      "if-none-match": '"0123abcd"',
    });

    expect(response.status).toBe(412);
  });
});

/** The `Last-Modified` of the object of `statOf`, whose `lastModified` lies at `.456`. */
const lastModified = "Tue, 01 Sep 2026 10:20:30 GMT";
const secondBefore = "Tue, 01 Sep 2026 10:20:29 GMT";

describe("`If-Modified-Since`", () => {
  test.each([
    ["the `Last-Modified`", lastModified],
    ["a later date", "Wed, 02 Sep 2026 00:00:00 GMT"],
    ["the `Last-Modified` in RFC 850's form", "Tuesday, 01-Sep-26 10:20:30 GMT"],
    ["the `Last-Modified` in `asctime`'s form", "Tue Sep  1 10:20:30 2026"],
  ])("with %s is `304` from `stat` alone", async (_, field) => {
    const { storage, calls } = rangingStorage();
    const response = await serveConditional({ "if-modified-since": field }, storage);

    expect(response.status).toBe(304);
    expect(calls).toEqual(["stat"]);
  });

  test("with a second before the `Last-Modified` is `200`", async () => {
    expect((await serveConditional({ "if-modified-since": secondBefore })).status).toBe(200);
  });

  test.each(["GET", "HEAD"])(
    "on `%s` compares with `lastModified` where it is later than the response's date",
    async (method) => {
      vi.useFakeTimers({ toFake: ["Date"] });
      vi.setSystemTime(new Date("2026-09-01T10:20:29.900Z"));

      const response = await serveConditional(
        { "if-modified-since": secondBefore },
        undefined,
        method,
      );

      expect(response.status).toBe(200);
      expect(response.headers.get("last-modified")).toBe(secondBefore);
      expect(response.headers.get("date")).toBe(secondBefore);
    },
  );

  test.each([
    ["no date", "yesterday"],
    ["two dates", `${lastModified}, ${lastModified}`],
    ["a day the month lacks", "Wed, 31 Sep 2026 10:20:30 GMT"],
    ["another zone", "Tue, 01 Sep 2026 10:20:30 CET"],
  ])("with %s is ignored, without a `stat`", async (_, field) => {
    const { storage, calls } = rangingStorage();
    const response = await serveConditional({ "if-modified-since": field }, storage);

    expect(response.status).toBe(200);
    expect(calls).toEqual(["get"]);
  });

  test("beside `If-None-Match` is ignored", async () => {
    const response = await serveConditional({
      "if-none-match": '"other"',
      "if-modified-since": lastModified,
    });

    expect(response.status).toBe(200);
  });
});

describe("`If-Unmodified-Since`", () => {
  test("with the `Last-Modified` is `200`", async () => {
    expect((await serveConditional({ "if-unmodified-since": lastModified })).status).toBe(200);
  });

  test("with a second before the `Last-Modified` is `412` from `stat` alone", async () => {
    const { storage, calls } = rangingStorage();
    const response = await serveConditional({ "if-unmodified-since": secondBefore }, storage);

    expect(response.status).toBe(412);
    expect(calls).toEqual(["stat"]);
  });

  test.each(["GET", "HEAD"])(
    "on `%s` compares with `lastModified` where it is later than the response's date",
    async (method) => {
      vi.useFakeTimers({ toFake: ["Date"] });
      vi.setSystemTime(new Date("2026-09-01T10:20:29.900Z"));

      const { storage, calls } = rangingStorage();
      const response = await serveConditional(
        { "if-unmodified-since": secondBefore },
        storage,
        method,
      );

      expect(response.status).toBe(412);
      expect(calls).toEqual(["stat"]);
    },
  );

  test("beside `If-Match` is ignored", async () => {
    const response = await serveConditional({
      "if-match": "*",
      "if-unmodified-since": secondBefore,
    });

    expect(response.status).toBe(200);
  });

  test("is evaluated before `If-None-Match`", async () => {
    const response = await serveConditional({
      "if-unmodified-since": secondBefore,
      "if-none-match": '"0123abcd"',
    });

    expect(response.status).toBe(412);
  });
});

describe("preconditions on a `HEAD`", () => {
  test.each([
    ["If-Match", { "if-match": '"other"' }],
    ["If-Unmodified-Since", { "if-unmodified-since": secondBefore }],
  ])("a failed `%s` carries the call-time `Date`", async (_, headers) => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-09-01T10:20:31.900Z"));

    const storage = stubStorage({
      stat: async () => {
        vi.setSystemTime(new Date("2026-09-01T10:20:35Z"));

        return statOf();
      },
    });
    const response = await serveConditional(headers, storage, "HEAD");

    expect(response.status).toBe(412);
    expect(response.body).toBeNull();
    expect([...response.headers]).toEqual([["date", "Tue, 01 Sep 2026 10:20:31 GMT"]]);
  });

  test.each([
    ["a failed `If-None-Match`", 304, { "if-none-match": '"0123abcd"' }],
    ["a failed `If-Modified-Since`", 304, { "if-modified-since": lastModified }],
    ["a failed `If-Match`", 412, { "if-match": '"other"' }],
    ["a failed `If-Unmodified-Since`", 412, { "if-unmodified-since": secondBefore }],
    ["preconditions that hold", 200, { "if-match": "*", "if-none-match": '"other"' }],
  ])("answer %s with %i from `stat` alone", async (_, status, headers) => {
    const { storage, calls } = rangingStorage();
    const response = await serveConditional(headers, storage, "HEAD");

    expect(response.status).toBe(status);
    expect(await response.text()).toBe("");
    expect(calls).toEqual(["stat"]);
  });
});

describe("`If-Range`", () => {
  test("with the `ETag` is `206` with the range, after one `stat`", async () => {
    const { storage, calls } = rangingStorage();
    const response = await serveConditional(
      { range: "bytes=2-5", "if-range": '"0123abcd"' },
      storage,
    );

    expect(response.status).toBe(206);
    expect(await response.text()).toBe("2345");
    expect(calls).toEqual(["stat", "get 2-5"]);
  });

  test.each([
    ["another tag", '"other"'],
    ["the `ETag` as weak", 'W/"0123abcd"'],
    ["the `ETag` in a list", '"0123abcd",'],
    ["the `Last-Modified`", lastModified],
    ["a later date", "Wed, 02 Sep 2026 00:00:00 GMT"],
  ])("with %s is `200` with the whole object", async (_, field) => {
    const { storage, calls } = rangingStorage();
    const response = await serveConditional({ range: "bytes=2-5", "if-range": field }, storage);

    expect(response.status).toBe(200);
    expect(await response.text()).toBe(sixteenBytes);
    expect(response.headers.has("content-range")).toBe(false);
    expect(calls).toEqual(["stat", "get"]);
  });

  test("with the `ETag` on a suffix is `206` after one `stat`", async () => {
    const { storage, calls } = rangingStorage();
    const response = await serveConditional(
      { range: "bytes=-3", "if-range": '"0123abcd"' },
      storage,
    );

    expect(response.status).toBe(206);
    expect(calls).toEqual(["stat", "get 13-15"]);
  });

  test.each([
    ["without a `Range`", {}, ["rangeReads"]],
    ["beside a `Range` spec 10.3 ignores", { range: "bytes=0-1,3-4" }, ["rangeReads"]],
    ["on a storage without `rangeReads`", { range: "bytes=2-5" }, []],
  ] as const)("%s is ignored, without a `stat`", async (_, headers, capabilities) => {
    const { storage, calls } = rangingStorage({ capabilities });
    const response = await serveConditional({ ...headers, "if-range": '"other"' }, storage);

    expect(response.status).toBe(200);
    expect(calls).toEqual(["get"]);
  });

  test("on a `HEAD` is ignored", async () => {
    const { storage, calls } = rangingStorage();
    const response = await serveConditional(
      { range: "bytes=2-5", "if-range": '"other"' },
      storage,
      "HEAD",
    );

    expect(response.status).toBe(200);
    expect(calls).toEqual(["stat"]);
  });

  test("is evaluated after the other preconditions", async () => {
    const response = await serveConditional({
      range: "bytes=2-5",
      "if-range": '"0123abcd"',
      "if-none-match": '"0123abcd"',
    });

    expect(response.status).toBe(304);
  });
});

test("a suffix beside preconditions is served after one `stat`", async () => {
  const { storage, calls } = rangingStorage();
  const response = await serveConditional({ range: "bytes=-3", "if-match": "*" }, storage);

  expect(response.status).toBe(206);
  expect(calls).toEqual(["stat", "get 13-15"]);
});

const sized = (fields: Partial<ObjectStat> = {}): ObjectStat =>
  statOf({ size: sixteenBytes.length, ...fields });

/**
 * A storage declaring `rangeReads` whose `stat` sees the object `seen`, and whose `get`s
 * each hand over the next of `handed`, as an object changing between the calls would. It
 * records each call in `calls` and the `etag` of each body canceled in `canceled`.
 */
const changingStorage = (
  seen: Partial<ObjectStat>,
  ...handed: Partial<ObjectStat>[]
): { storage: Storage; calls: string[]; canceled: (string | undefined)[] } => {
  const calls: string[] = [];
  const canceled: (string | undefined)[] = [];

  const storage = stubStorage({
    capabilities: ["rangeReads"],
    stat: async () => {
      calls.push("stat");

      return sized(seen);
    },
    get: async (_key, options) => {
      const range = options?.range;
      const stat = sized(handed.shift());

      calls.push(range === undefined ? "get" : `get ${range.start}-${range.end ?? ""}`);

      const bytes = new TextEncoder().encode(
        range === undefined ? sixteenBytes : sixteenBytes.slice(range.start, (range.end ?? 15) + 1),
      );
      // Pulled only once read, so that a canceled body is told apart from a read one.
      const body = new ReadableStream<Uint8Array>(
        {
          pull: (controller) => {
            controller.enqueue(bytes);
            controller.close();
          },
          cancel: () => {
            canceled.push(stat.etag);
          },
        },
        { highWaterMark: 0 },
      );

      return storedObject(stat, body);
    },
  });

  return { storage, calls, canceled };
};

describe("an object changing between `stat` and `get`", () => {
  test("is answered by the `stat` of `get` where the outcome stays", async () => {
    const { storage, calls, canceled } = changingStorage({ etag: "seen" }, { etag: "handed" });
    const response = await serveConditional({ "if-none-match": '"other"' }, storage);

    expect(response.status).toBe(200);
    expect(response.headers.get("etag")).toBe('"handed"');
    expect(await response.text()).toBe(sixteenBytes);
    expect(calls).toEqual(["stat", "get"]);
    expect(canceled).toEqual([]);
  });

  test("has its body canceled and `304` answered where `If-None-Match` now fails", async () => {
    const { storage, calls, canceled } = changingStorage({ etag: "seen" }, { etag: "handed" });
    const response = await serveConditional({ "if-none-match": '"handed"' }, storage);

    expect(response.status).toBe(304);
    expect(response.headers.get("etag")).toBe('"handed"');
    expect(await response.text()).toBe("");
    expect(calls).toEqual(["stat", "get"]);
    expect(canceled).toEqual(["handed"]);
  });

  test("has its body canceled and `412` answered where `If-Match` now fails", async () => {
    const { storage, canceled } = changingStorage({ etag: "seen" }, { etag: "handed" });
    const response = await serveConditional({ "if-match": '"seen"' }, storage);

    expect(response.status).toBe(412);
    expect(canceled).toEqual(["handed"]);
  });

  test("is followed by one whole `get` where `If-Range` no longer holds", async () => {
    const { storage, calls, canceled } = changingStorage(
      { etag: "seen" },
      { etag: "handed" },
      { etag: "handed" },
    );
    const response = await serveConditional({ range: "bytes=2-5", "if-range": '"seen"' }, storage);

    expect(response.status).toBe(200);
    expect(await response.text()).toBe(sixteenBytes);
    expect(response.headers.get("etag")).toBe('"handed"');
    expect(calls).toEqual(["stat", "get 2-5", "get"]);
    expect(canceled).toEqual(["handed"]);
  });

  test("is followed by one whole `get` where a suffix now names other bytes", async () => {
    const { storage, calls } = changingStorage(
      { etag: "seen" },
      { etag: "handed", size: 20 },
      { etag: "handed", size: 20 },
    );
    const response = await serveConditional({ range: "bytes=-3" }, storage);

    expect(response.status).toBe(200);
    expect(response.headers.has("content-range")).toBe(false);
    expect(calls).toEqual(["stat", "get 13-15", "get"]);
  });

  test("is still `206` where a suffix names the same bytes", async () => {
    const { storage, calls } = changingStorage({ etag: "seen" }, { etag: "handed" });
    const response = await serveConditional({ range: "bytes=-3" }, storage);

    expect(response.status).toBe(206);
    expect(response.headers.get("etag")).toBe('"handed"');
    expect(calls).toEqual(["stat", "get 13-15"]);
  });

  test("answers a failed precondition after the one more `get`, and no third", async () => {
    const { storage, calls, canceled } = changingStorage(
      { etag: "seen" },
      { etag: "handed" },
      { etag: "third" },
    );
    const response = await serveConditional(
      { range: "bytes=2-5", "if-range": '"seen"', "if-none-match": '"third"' },
      storage,
    );

    expect(response.status).toBe(304);
    expect(response.headers.get("etag")).toBe('"third"');
    expect(calls).toEqual(["stat", "get 2-5", "get"]);
    expect(canceled).toEqual(["handed", "third"]);
  });

  test("counts as changed without `etag`s where `lastModified` differs", async () => {
    const { storage, canceled } = changingStorage(
      { etag: undefined },
      { etag: undefined, lastModified: new Date("2026-09-01T10:20:31Z") },
    );
    const response = await serveConditional({ "if-unmodified-since": lastModified }, storage);

    expect(response.status).toBe(412);
    expect(canceled).toEqual([undefined]);
  });

  test("rechecks a future `lastModified` against date preconditions and cancels the body", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-09-01T10:20:30.900Z"));

    const { storage, calls, canceled } = changingStorage(
      { etag: undefined },
      { etag: undefined, lastModified: new Date("2026-09-01T10:20:31.456Z") },
    );
    const response = await serveConditional({ "if-unmodified-since": lastModified }, storage);

    expect(response.status).toBe(412);
    expect([...response.headers]).toEqual([]);
    expect(calls).toEqual(["stat", "get"]);
    expect(canceled).toEqual([undefined]);
  });

  test("counts as changed without `etag`s where `size` differs", async () => {
    const { storage, calls } = changingStorage(
      { etag: undefined },
      { etag: undefined, size: 20 },
      { etag: undefined, size: 20 },
    );
    const response = await serveConditional({ range: "bytes=-3" }, storage);

    expect(response.status).toBe(200);
    expect(calls).toEqual(["stat", "get 13-15", "get"]);
  });

  test("counts as unchanged where the `etag`s agree, whatever else differs", async () => {
    const { storage, canceled } = changingStorage(
      {},
      { lastModified: new Date("2026-09-01T10:20:31Z") },
    );
    const response = await serveConditional({ "if-unmodified-since": lastModified }, storage);

    expect(response.status).toBe(200);
    expect(canceled).toEqual([]);
  });
});

/** A range refused after `seen` changes, with `next` returned by the following `stat`. */
const invalidatedRangeStorage = (
  seen: Partial<ObjectStat>,
  next: Partial<ObjectStat>,
  handed: Partial<ObjectStat> = next,
): { storage: Storage; calls: string[]; refusal: StorageError } => {
  const calls: string[] = [];
  const refusal = storageError({ code: "InvalidRequest" });
  let stats = 0;

  const storage = stubStorage({
    capabilities: ["rangeReads"],
    stat: async () => {
      calls.push("stat");

      return sized(stats++ === 0 ? seen : next);
    },
    get: async (_key, options) => {
      const range = options?.range;

      calls.push(range === undefined ? "get" : `get ${range.start}-${range.end ?? ""}`);

      if (range !== undefined) throw refusal;

      const stat = sized(handed);

      return storedObject(stat, streamOf(sixteenBytes.slice(0, stat.size)));
    },
  });

  return { storage, calls, refusal };
};

describe("a ranged `get` rejecting with `InvalidRequest` after planning", () => {
  test.each([
    ["if-match", '"seen"', 412],
    ["if-none-match", '"next"', 304],
  ])("answers the %s that now fails from the second `stat`", async (header, value, status) => {
    const { storage, calls } = invalidatedRangeStorage({ etag: "seen" }, { etag: "next", size: 4 });
    const response = await serveConditional({ range: "bytes=13-", [header]: value }, storage);

    expect(response.status).toBe(status);
    expect(await response.text()).toBe("");
    expect(response.headers.has("content-range")).toBe(false);
    expect(response.headers.get("etag")).toBe(status === 304 ? '"next"' : null);
    expect(storageErrorOf(response)).toBeUndefined();
    expect(calls).toEqual(["stat", "get 13-", "stat"]);
  });

  test.each([
    ["If-Range no longer holds", "bytes=13-", { "if-range": '"seen"' }, 4, "seen", "next"],
    ["a suffix names other bytes", "bytes=-3", {}, 4, "seen", "next"],
    ["a suffix becomes empty", "bytes=-3", {}, 0, "seen", "next"],
    ["a suffix changes without etags", "bytes=-3", {}, 4, undefined, undefined],
  ])("serves the whole object where %s", async (_, range, headers, size, seen, next) => {
    const { storage, calls } = invalidatedRangeStorage({ etag: seen }, { etag: next, size });
    const response = await serveConditional({ range, ...headers }, storage);

    expect(response.status).toBe(200);
    expect(await response.text()).toBe(sixteenBytes.slice(0, size));
    expect(response.headers.has("content-range")).toBe(false);
    expect(response.headers.get("content-length")).toBe(String(size));
    expect(storageErrorOf(response)).toBeUndefined();
    expect(calls).toEqual(["stat", range === "bytes=-3" ? "get 13-15" : "get 13-", "stat", "get"]);
  });

  test("rechecks preconditions against the whole `get` after the second `stat`", async () => {
    const { storage, calls } = invalidatedRangeStorage(
      { etag: "seen" },
      { etag: "next", size: 4 },
      { etag: "third", size: 4 },
    );
    const response = await serveConditional(
      { range: "bytes=13-", "if-range": '"seen"', "if-none-match": '"third"' },
      storage,
    );

    expect(response.status).toBe(304);
    expect(response.headers.get("etag")).toBe('"third"');
    expect(await response.text()).toBe("");
    expect(calls).toEqual(["stat", "get 13-", "stat", "get"]);
  });

  test.each([
    ["unchanged", "seen", 16],
    ["changed", "next", 4],
  ])("is still `416` where the %s object keeps the same range", async (_, etag, size) => {
    const { storage, calls, refusal } = invalidatedRangeStorage({ etag: "seen" }, { etag, size });
    const response = await serveConditional({ range: "bytes=16-", "if-match": "*" }, storage);

    expect(response.status).toBe(416);
    expect(response.headers.get("content-range")).toBe(`bytes */${size}`);
    expect(await response.text()).toBe("");
    expect(storageErrorOf(response)).toBe(refusal);
    expect(calls).toEqual(["stat", "get 16-", "stat"]);
  });
});

test("a missing object is `404` whatever preconditions the request carries", async () => {
  const gone = storageError({ code: "NotFound", key: "docs/report.pdf" });
  const storage = stubStorage({
    stat: async () => {
      throw gone;
    },
  });

  const preconditions: Record<string, string>[] = [{ "if-match": "*" }, { "if-none-match": "*" }];

  for (const headers of preconditions) {
    for (const method of ["GET", "HEAD"]) {
      // oxlint-disable-next-line no-await-in-loop -- one request after the other
      const response = await serveConditional(headers, storage, method);

      expect(response.status).toBe(404);
      expect(storageErrorOf(response)).toBe(gone);
    }
  }
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
