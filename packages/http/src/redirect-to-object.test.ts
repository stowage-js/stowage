import { describe, expect, test } from "vitest";

import { type PresignsGet, redirectToObject, storageErrorOf } from "./index.ts";
import { storageError } from "./stubs.ts";

const request = (method: string): Request =>
  new Request("http://localhost/files/report", { method });

type PresignGetOptions = Parameters<PresignsGet["presignGet"]>[1];

const signedUrl = "https://bucket.example/docs/report.pdf?X-Signature=abc";

/** A storage signing every key with `signedUrl`, keeping each call it was asked for. */
function signing(): PresignsGet & { readonly calls: [string, PresignGetOptions][] } {
  const calls: [string, PresignGetOptions][] = [];

  return {
    calls,
    presignGet: async (key, options) => {
      calls.push([key, options]);

      return signedUrl;
    },
  };
}

const redirect = async (method: string, storage: PresignsGet = signing()): Promise<Response> =>
  await redirectToObject(storage, "docs/report.pdf", request(method), { expiresIn: 60 });

describe("`GET` and `HEAD`", () => {
  test.each(["GET", "HEAD"])(
    "`%s` answers `302` to the presigned URL with an empty body",
    async (method) => {
      const response = await redirect(method);

      expect(response.status).toBe(302);
      expect(response.headers.get("location")).toBe(signedUrl);
      expect(response.headers.get("cache-control")).toBe("private, no-store");
      expect(await response.text()).toBe("");
    },
  );

  test("are answered with the same headers", async () => {
    expect([...(await redirect("HEAD")).headers]).toEqual([...(await redirect("GET")).headers]);
  });

  test("the answer's headers are the caller's to change", async () => {
    const response = await redirect("GET");

    response.headers.set("location", "https://elsewhere.example/");
    response.headers.set("access-control-allow-origin", "*");

    expect(response.headers.get("location")).toBe("https://elsewhere.example/");
    expect(response.headers.get("access-control-allow-origin")).toBe("*");
  });
});

describe("any other method", () => {
  test.each(["POST", "PUT", "DELETE", "PATCH", "OPTIONS"])(
    "`%s` answers `405` with `Allow: GET, HEAD` and presigns nothing",
    async (method) => {
      const storage = signing();
      const response = await redirect(method, storage);

      expect(response.status).toBe(405);
      expect(response.headers.get("allow")).toBe("GET, HEAD");
      expect(await response.text()).toBe("");
      expect(storageErrorOf(response)).toBeUndefined();
      expect(storage.calls).toEqual([]);
    },
  );
});

describe("the options of `presignGet`", () => {
  test("`expiresIn` is passed on unchanged, beside the key", async () => {
    const storage = signing();

    await redirectToObject(storage, "docs/report.pdf", request("GET"), { expiresIn: 3600 });

    expect(storage.calls).toEqual([
      ["docs/report.pdf", expect.objectContaining({ expiresIn: 3600 })],
    ]);
  });

  test.each([
    [
      "the key's last segment as an attachment by default",
      {},
      `attachment; filename="report.pdf"; filename*=UTF-8''report.pdf`,
    ],
    [
      "`filename` in place of the key's last segment",
      { filename: "résumé 100%.pdf" },
      `attachment; filename="r_sum_ 100_.pdf"; filename*=UTF-8''r%C3%A9sum%C3%A9%20100%25.pdf`,
    ],
    [
      "`inline` where `disposition` asks for it",
      { disposition: "inline" },
      `inline; filename="report.pdf"; filename*=UTF-8''report.pdf`,
    ],
  ] as const)("`responseContentDisposition` names %s", async (_, options, expected) => {
    const storage = signing();

    await redirectToObject(storage, "docs/report.pdf", request("GET"), {
      expiresIn: 60,
      ...options,
    });

    expect(storage.calls).toEqual([
      ["docs/report.pdf", { expiresIn: 60, responseContentDisposition: expected }],
    ]);
  });

  test("a key ending in `/` gets `attachment` alone", async () => {
    const storage = signing();

    await redirectToObject(storage, "docs/", request("GET"), { expiresIn: 60 });

    expect(storage.calls[0]?.[1].responseContentDisposition).toBe("attachment");
  });
});

/** A storage whose `presignGet` rejects with `thrown`. */
const refusing = (thrown: unknown): PresignsGet => ({
  presignGet: async () => {
    throw thrown;
  },
});

describe("a `StorageError` from `presignGet`", () => {
  test.each([
    { row: "`InvalidKey`", fields: { code: "InvalidKey", key: "a//b" }, status: 404 },
    { row: "`InvalidOption`", fields: { code: "InvalidOption" }, status: 500 },
    { row: "`InvalidCredentials`", fields: { code: "InvalidCredentials" }, status: 500 },
    { row: "`NetworkError`", fields: { code: "NetworkError", retryable: true }, status: 503 },
  ] as const)(
    "$row answers `GET` and `HEAD` with $status and an empty body",
    async ({ fields, status }) => {
      const error = storageError({ operation: "presignGet", ...fields });

      for (const method of ["GET", "HEAD"]) {
        // oxlint-disable-next-line no-await-in-loop -- one method after the other
        const response = await redirect(method, refusing(error));

        expect(response.status).toBe(status);
        expect(response.headers.has("location")).toBe(false);
        // oxlint-disable-next-line no-await-in-loop -- one method after the other
        expect(await response.text()).toBe("");
        expect(storageErrorOf(response)).toBe(error);
      }
    },
  );

  test("anything else thrown is thrown on", async () => {
    const thrown = new TypeError("storage.presignGet is not a function");

    await expect(redirect("GET", refusing(thrown))).rejects.toBe(thrown);
  });
});
