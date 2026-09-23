import { isStorageError, type StorageError } from "@stowage/core";
import { afterEach, beforeEach, expect, test, vi } from "vitest";

import { type S3AdapterOptions, type S3Credentials, s3Storage } from "./index.ts";

beforeEach(() => {
  // Spec 7.10 has neither method send a request, so any `fetch` fails the test.
  vi.stubGlobal("fetch", () => {
    throw new Error("A presigned URL was signed by sending a request");
  });
  vi.useFakeTimers({ now: new Date("2026-09-23T08:00:00Z"), toFake: ["Date"] });
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

const credentials = { accessKeyId: "AKIDEXAMPLE", secretAccessKey: "secret" };

function options(overrides: Partial<S3AdapterOptions> = {}): S3AdapterOptions {
  return { bucket: "stowage", region: "eu-central-1", credentials, ...overrides };
}

async function rejection(act: () => Promise<unknown>): Promise<StorageError> {
  try {
    await act();
  } catch (failure) {
    if (isStorageError(failure)) return failure;

    throw failure;
  }

  throw new Error("The call resolved");
}

/** The query of the URL by name, which the tests read rather than the order it came in. */
function queryOf(url: string): Record<string, string> {
  return Object.fromEntries(new URL(url).searchParams);
}

const putOptions = { expiresIn: 300, contentType: "text/plain", contentLength: 12 };

test("the storage declares `presignedUrls` and carries both methods", () => {
  const storage = s3Storage(options());

  expect(storage.capabilities).toContain("presignedUrls");
  expect(typeof storage.presignGet).toBe("function");
  expect(typeof storage.presignPut).toBe("function");
});

test("`presignGet` signs a `GET` of the key for the lifetime asked", async () => {
  const url = await s3Storage(options()).presignGet("folder/object.txt", { expiresIn: 300 });
  const parsed = new URL(url);

  expect(`${parsed.origin}${parsed.pathname}`).toBe(
    "https://stowage.s3.eu-central-1.amazonaws.com/folder/object.txt",
  );
  expect(queryOf(url)).toMatchObject({
    "X-Amz-Algorithm": "AWS4-HMAC-SHA256",
    "X-Amz-Credential": "AKIDEXAMPLE/20260923/eu-central-1/s3/aws4_request",
    "X-Amz-Date": "20260923T080000Z",
    "X-Amz-Expires": "300",
    "X-Amz-SignedHeaders": "host",
  });
  expect(queryOf(url)["X-Amz-Signature"]).toMatch(/^[\da-f]{64}$/u);
});

test("`presignGet` sends the four response overrides as query parameters", async () => {
  const url = await s3Storage(options()).presignGet("object.txt", {
    expiresIn: 300,
    responseContentType: "text/plain; charset=utf-8",
    responseContentDisposition: 'attachment; filename="report 1.txt"',
    responseCacheControl: "no-store",
    responseExpires: "Wed, 23 Sep 2026 09:00:00 GMT",
  });

  expect(queryOf(url)).toMatchObject({
    "response-content-type": "text/plain; charset=utf-8",
    "response-content-disposition": 'attachment; filename="report 1.txt"',
    "response-cache-control": "no-store",
    "response-expires": "Wed, 23 Sep 2026 09:00:00 GMT",
  });
});

// The provider rebuilds the canonical query from the URL it was called with, so the URL
// carries each pair encoded as it was signed rather than as `URLSearchParams` writes it.
test("the URL carries its query encoded as SigV4 signs it", async () => {
  const url = await s3Storage(options()).presignGet("object.txt", {
    expiresIn: 300,
    responseContentDisposition: 'attachment; filename="a b*.txt"',
  });

  expect(url).toContain(
    "response-content-disposition=attachment%3B%20filename%3D%22a%20b%2A.txt%22",
  );
});

test("`presignGet` takes an addressable key that is not writable", async () => {
  const url = await s3Storage(options()).presignGet("another\\tool.txt", { expiresIn: 300 });

  expect(new URL(url).pathname).toBe("/another%5Ctool.txt");
});

test("`presignPut` binds the content type and the content length through signed headers", async () => {
  const url = await s3Storage(options()).presignPut("folder/object.txt", putOptions);

  expect(new URL(url).pathname).toBe("/folder/object.txt");
  expect(queryOf(url)["X-Amz-SignedHeaders"]).toBe("content-length;content-type;host");
});

test("a presigned `PUT` binds no header beyond the two and `host`", async () => {
  const url = await s3Storage(options()).presignPut("object.txt", putOptions);

  expect(Object.keys(queryOf(url)).filter((name) => !name.startsWith("X-Amz-"))).toEqual([]);
});

test("`presignPut` refuses a key that is addressable and not writable", async () => {
  const failure = await rejection(
    async () => await s3Storage(options()).presignPut("another\\tool.txt", putOptions),
  );

  expect(failure).toMatchObject({ code: "InvalidKey", operation: "presignPut", attempts: 0 });
});

test("a key is percent-encoded segment by segment on the URL", async () => {
  const url = await s3Storage(options()).presignPut("a b/c#d/e%f/g+h/ሴ", putOptions);

  expect(url.split("?")[0]).toBe(
    "https://stowage.s3.eu-central-1.amazonaws.com/a%20b/c%23d/e%25f/g%2Bh/%E1%88%B4",
  );
});

test("the URL addresses a configured endpoint path-style", async () => {
  const url = await s3Storage(
    options({ endpoint: "http://127.0.0.1:8333", forcePathStyle: true }),
  ).presignGet("object.txt", { expiresIn: 300 });

  expect(url.split("?")[0]).toBe("http://127.0.0.1:8333/stowage/object.txt");
});

test("the session token is signed into the query", async () => {
  const url = await s3Storage(
    options({ credentials: { ...credentials, sessionToken: "session" } }),
  ).presignGet("object.txt", { expiresIn: 300 });

  expect(queryOf(url)["X-Amz-Security-Token"]).toBe("session");
});

test("the credential is resolved for every URL and nothing is held between them", async () => {
  const resolve = vi.fn<() => S3Credentials>(() => credentials);
  const storage = s3Storage(options({ credentials: resolve }));

  await storage.presignGet("object.txt", { expiresIn: 300 });
  await storage.presignPut("object.txt", putOptions);

  expect(resolve.mock.calls).toEqual([[{ forceRefresh: false }], [{ forceRefresh: false }]]);
});

test.each([1, 604_800])("an `expiresIn` of %s is signed", async (expiresIn) => {
  const url = await s3Storage(options()).presignGet("object.txt", { expiresIn });

  expect(queryOf(url)["X-Amz-Expires"]).toBe(String(expiresIn));
});

test.each([0, 604_801, 1.5, -1, Number.NaN, Number.POSITIVE_INFINITY, undefined])(
  "an `expiresIn` of %s is `InvalidOption` naming it before signing",
  async (expiresIn) => {
    const resolve = vi.fn<() => S3Credentials>(() => credentials);
    const storage = s3Storage(options({ credentials: resolve }));
    // oxlint-disable-next-line no-unsafe-type-assertion -- a caller outside TypeScript
    const lifetime = { expiresIn } as { expiresIn: number };

    for (const failure of [
      await rejection(async () => await storage.presignGet("object.txt", lifetime)),
      await rejection(
        async () => await storage.presignPut("object.txt", { ...putOptions, ...lifetime }),
      ),
    ]) {
      expect(failure).toMatchObject({ code: "InvalidOption", attempts: 0 });
      expect(failure.message).toContain("`expiresIn`");
      expect(failure.message).toContain("604800");
    }

    expect(resolve).not.toHaveBeenCalled();
  },
);

test.each([0, 5 * 1024 ** 3])("a `contentLength` of %s is signed", async (contentLength) => {
  await expect(
    s3Storage(options()).presignPut("object.txt", { ...putOptions, contentLength }),
  ).resolves.toMatch(/^https:/u);
});

test.each([-1, 1.5, Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY, undefined])(
  "a `contentLength` of %s is `InvalidOption` naming it before signing",
  async (contentLength) => {
    const resolve = vi.fn<() => S3Credentials>(() => credentials);
    const failure = await rejection(
      async () =>
        await s3Storage(options({ credentials: resolve })).presignPut("object.txt", {
          ...putOptions,
          // oxlint-disable-next-line no-unsafe-type-assertion -- a caller outside TypeScript
          contentLength: contentLength as number,
        }),
    );

    expect(failure).toMatchObject({ code: "InvalidOption", operation: "presignPut" });
    expect(failure.message).toContain("`contentLength`");
    expect(resolve).not.toHaveBeenCalled();
  },
);

test.each([undefined, "", 12])(
  "a `contentType` of %s is `InvalidOption` naming it",
  async (contentType) => {
    const failure = await rejection(
      async () =>
        await s3Storage(options()).presignPut("object.txt", {
          ...putOptions,
          // oxlint-disable-next-line no-unsafe-type-assertion -- a caller outside TypeScript
          contentType: contentType as string,
        }),
    );

    expect(failure).toMatchObject({ code: "InvalidOption", operation: "presignPut" });
    expect(failure.message).toContain("`contentType`");
  },
);

test("a response override that is no string is `InvalidOption` naming it", async () => {
  const failure = await rejection(
    async () =>
      await s3Storage(options()).presignGet("object.txt", {
        expiresIn: 300,
        // oxlint-disable-next-line no-unsafe-type-assertion -- a caller outside TypeScript
        responseCacheControl: 60 as unknown as string,
      }),
  );

  expect(failure).toMatchObject({ code: "InvalidOption", operation: "presignGet" });
  expect(failure.message).toContain("`responseCacheControl`");
});

test("an unknown option is refused by name", async () => {
  const storage = s3Storage(options());
  const unknown = { expiresIn: 300, userMetadata: { a: "b" } };

  const failures = [
    await rejection(async () => await storage.presignGet("object.txt", unknown)),
    await rejection(
      async () => await storage.presignPut("object.txt", { ...putOptions, ...unknown }),
    ),
  ];

  for (const failure of failures) {
    expect(failure).toMatchObject({ code: "InvalidOption", attempts: 0 });
    expect(failure.message).toContain("`userMetadata`");
  }
});

test("options that are no group are `InvalidOption`", async () => {
  const failure = await rejection(
    // oxlint-disable-next-line no-unsafe-type-assertion -- a caller outside TypeScript
    async () => await s3Storage(options()).presignGet("object.txt", undefined as never),
  );

  expect(failure).toMatchObject({ code: "InvalidOption", operation: "presignGet" });
});

test("the key is checked before the options and the options before the credential", async () => {
  const resolve = vi.fn<() => S3Credentials>(() => credentials);
  const storage = s3Storage(options({ credentials: resolve }));

  const failure = await rejection(
    async () => await storage.presignGet("/leading-slash", { expiresIn: 0 }),
  );

  expect(failure.code).toBe("InvalidKey");
  expect(resolve).not.toHaveBeenCalled();
});

test("a credential the adapter refuses is `InvalidCredentials` told against the storage", async () => {
  const failure = await rejection(
    async () =>
      await s3Storage(
        options({ credentials: { accessKeyId: "AKIDEXAMPLE", secretAccessKey: "" } }),
      ).presignPut("object.txt", putOptions),
  );

  expect(failure).toMatchObject({
    code: "InvalidCredentials",
    operation: "presignPut",
    bucket: "stowage",
    key: "object.txt",
    attempts: 0,
  });
});
