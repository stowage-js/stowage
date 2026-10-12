import { type PresignedPut, preconditionRefusal } from "@stowage/core";
import { describe, expect, test } from "vitest";

import {
  type PresignsPut,
  presignUpload,
  type PresignUploadOptions,
  storageErrorOf,
} from "./index.ts";
import { storageError } from "./stubs.ts";

type PresignPutOptions = Parameters<PresignsPut["presignPut"]>[1];

const signed: PresignedPut = {
  url: "https://bucket.example/uploads/report.pdf?X-Signature=abc",
  headers: { "content-type": "application/pdf" },
};

/** A storage signing every upload with `signed`, keeping each call it was asked for. */
function signing(): PresignsPut & { readonly calls: [string, PresignPutOptions][] } {
  const calls: [string, PresignPutOptions][] = [];

  return {
    calls,
    presignPut: async (key, options) => {
      calls.push([key, options]);

      return signed;
    },
  };
}

const options = (fields: Partial<PresignUploadOptions> = {}): PresignUploadOptions => ({
  expiresIn: 60,
  maxSize: 1024,
  contentType: "application/pdf",
  contentLength: 11,
  ...fields,
});

describe("a signed upload", () => {
  test("`expiresIn` and the client's values are passed on unchanged, beside the key", async () => {
    const storage = signing();

    await presignUpload(storage, "uploads/report.pdf", options({ expiresIn: 3600 }));

    expect(storage.calls).toEqual([
      [
        "uploads/report.pdf",
        { expiresIn: 3600, contentType: "application/pdf", contentLength: 11 },
      ],
    ]);
  });

  test("the content headers given are passed on unchanged", async () => {
    const storage = signing();

    await presignUpload(
      storage,
      "uploads/report.pdf",
      options({
        cacheControl: "public, max-age=60, immutable",
        contentDisposition: 'attachment; filename="report.pdf"',
        contentLanguage: "de-AT, en",
      }),
    );

    expect(storage.calls).toEqual([
      [
        "uploads/report.pdf",
        {
          expiresIn: 60,
          contentType: "application/pdf",
          contentLength: 11,
          cacheControl: "public, max-age=60, immutable",
          contentDisposition: 'attachment; filename="report.pdf"',
          contentLanguage: "de-AT, en",
        },
      ],
    ]);
  });

  test("a content header left out is no member of the options `presignPut` gets", async () => {
    const storage = signing();

    await presignUpload(storage, "uploads/report.pdf", options({ contentLanguage: "de-AT" }));

    expect(Object.keys(storage.calls[0]?.[1] ?? {}).toSorted()).toEqual([
      "contentLanguage",
      "contentLength",
      "contentType",
      "expiresIn",
    ]);
  });

  test.each(["absent", { etag: "e1" }] as const)(
    "`onlyIf` %j is passed on unchanged",
    async (onlyIf) => {
      const storage = signing();

      await presignUpload(storage, "uploads/report.pdf", options({ onlyIf }));

      expect(storage.calls).toEqual([
        [
          "uploads/report.pdf",
          { expiresIn: 60, contentType: "application/pdf", contentLength: 11, onlyIf },
        ],
      ]);
    },
  );

  test("the answer's headers are the caller's to change", async () => {
    const response = await presignUpload(signing(), "uploads/report.pdf", options());

    response.headers.set("access-control-allow-origin", "*");

    expect(response.headers.get("access-control-allow-origin")).toBe("*");
  });

  test("answers `200` with the presigned `PUT` as JSON", async () => {
    const response = await presignUpload(signing(), "uploads/report.pdf", options());

    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe("application/json");
    expect(response.headers.get("cache-control")).toBe("private, no-store");
    expect(await response.json()).toEqual({
      url: "https://bucket.example/uploads/report.pdf?X-Signature=abc",
      method: "PUT",
      headers: { "content-type": "application/pdf" },
    });
  });
});

/** What a refusal of the layer's own shows: no body, no `StorageError` and nothing signed. */
async function refusalOf(fields: Partial<PresignUploadOptions>): Promise<{
  readonly status: number;
  readonly body: string;
  readonly signed: number;
  readonly error: unknown;
}> {
  const storage = signing();
  const response = await presignUpload(storage, "uploads/report.pdf", options(fields));

  return {
    status: response.status,
    body: await response.text(),
    signed: storage.calls.length,
    error: storageErrorOf(response),
  };
}

const refused = (status: number) => ({ status, body: "", signed: 0, error: undefined });

describe("a `contentLength` the client sent", () => {
  test.each([
    ["-1", -1],
    ["1.5", 1.5],
    ["NaN", Number.NaN],
    ["Infinity", Number.POSITIVE_INFINITY],
    ['the string "11"', "11"],
    ["null", null],
  ])("%s, no non-negative integer, answers `400`", async (_, contentLength) => {
    // oxlint-disable-next-line no-unsafe-type-assertion -- a client's value, which no type holds back
    expect(await refusalOf({ contentLength: contentLength as number })).toEqual(refused(400));
  });

  test("above `maxSize` answers `413`", async () => {
    expect(await refusalOf({ maxSize: 1024, contentLength: 1025 })).toEqual(refused(413));
  });

  test.each([0, 1024])("%s, within `maxSize`, is signed", async (contentLength) => {
    const storage = signing();
    const response = await presignUpload(
      storage,
      "uploads/report.pdf",
      options({ maxSize: 1024, contentLength }),
    );

    expect(response.status).toBe(200);
    expect(storage.calls).toEqual([
      ["uploads/report.pdf", { expiresIn: 60, contentType: "application/pdf", contentLength }],
    ]);
  });
});

describe("a `contentType` the client sent", () => {
  test.each([
    ["empty", ""],
    ["holding a line feed", "a\nb"],
    ["holding a carriage return", "text/plain\r\nx-injected: 1"],
    ["holding a NUL", "text/plain\u0000"],
    ["starting with a space", " text/plain"],
    ["ending with a tab", "text/plain\t"],
    ["holding a character beyond ASCII", "text/plain; name=café"],
    ["no string", 11],
  ])("%s answers `400`", async (_, contentType) => {
    // oxlint-disable-next-line no-unsafe-type-assertion -- a client's value, which no type holds back
    expect(await refusalOf({ contentType: contentType as string })).toEqual(refused(400));
  });

  test.each(["text/plain", "text/plain; charset=utf-8", "application/vnd.api+json", "a\tb c"])(
    "%j is signed as it was sent",
    async (contentType) => {
      const storage = signing();

      await presignUpload(storage, "uploads/report.pdf", options({ contentType }));

      expect(storage.calls).toEqual([
        ["uploads/report.pdf", { expiresIn: 60, contentType, contentLength: 11 }],
      ]);
    },
  );
});

describe("a content header the client sent", () => {
  const contentHeaderOptions = ["cacheControl", "contentDisposition", "contentLanguage"] as const;

  test.each(
    contentHeaderOptions.flatMap((option) =>
      [
        ["empty", ""],
        ["holding a line feed", "a\nb"],
        ["starting with a space", " de"],
        ["holding a character beyond ASCII", 'attachment; filename="ü.pdf"'],
        ["no string", 11],
        ["null", null],
      ].map(([row, value]) => [option, row, value] as const),
    ),
  )("`%s` %s answers `400`", async (option, _, value) => {
    expect(await refusalOf({ [option]: value })).toEqual(refused(400));
  });

  const dispositionAtByteLimit = "a".repeat(
    2048 - "Content-Type".length - "application/pdf".length - "Content-Disposition".length,
  );

  test("past 2,048 header bytes with `Content-Type` answers `400`", async () => {
    expect(await refusalOf({ contentDisposition: `${dispositionAtByteLimit}a` })).toEqual(
      refused(400),
    );
  });

  test("at exactly 2,048 header bytes with `Content-Type` is signed", async () => {
    const storage = signing();
    const response = await presignUpload(
      storage,
      "uploads/report.pdf",
      options({ contentDisposition: dispositionAtByteLimit }),
    );

    expect(response.status).toBe(200);
    expect(storage.calls[0]?.[1].contentDisposition).toBe(dispositionAtByteLimit);
  });

  test("a `contentLanguage` of 101 characters answers `400`", async () => {
    expect(await refusalOf({ contentLanguage: "a".repeat(101) })).toEqual(refused(400));
  });

  test("a `contentLanguage` of exactly 100 characters is signed", async () => {
    const storage = signing();
    const contentLanguage = "a".repeat(100);

    const response = await presignUpload(
      storage,
      "uploads/report.pdf",
      options({ contentLanguage }),
    );

    expect(response.status).toBe(200);
    expect(storage.calls[0]?.[1].contentLanguage).toBe(contentLanguage);
  });
});

describe("an `onlyIf` the caller passes", () => {
  test.each([
    ['a string other than `"absent"`', "present"],
    ["an empty string", ""],
    ["null", null],
    ["a number", 1],
    ["an object without `etag`", {}],
    ["an empty `etag`", { etag: "" }],
    ["a weak `etag`", { etag: "W/e1" }],
    ['an `etag` holding `"`', { etag: 'e"1' }],
    ["an `etag` holding a space", { etag: "e 1" }],
    ["an `etag` beyond ASCII", { etag: "é1" }],
    ["an `etag` that is no string", { etag: 1 }],
    ["an `etag` beside another key", { etag: "e1", key: "a" }],
  ])("%s answers `400`", async (_, onlyIf) => {
    // oxlint-disable-next-line no-unsafe-type-assertion -- a client's value, which no type holds back
    expect(await refusalOf({ onlyIf: onlyIf as PresignUploadOptions["onlyIf"] })).toEqual(
      refused(400),
    );
  });

  // The form alone decides here, so the capability is the storage's to refuse: that is the
  // caller's storage, not the client's value (ADR 0074).
  test.each(["absent", { etag: "e1" }] as const)(
    "%j on a storage without the capability answers `500`",
    async (onlyIf) => {
      const response = await presignUpload(
        withoutPreconditions,
        "uploads/report.pdf",
        options({ onlyIf }),
      );

      expect(response.status).toBe(500);
      expect(await response.text()).toBe("");
      expect(storageErrorOf(response)?.code).toBe("Unsupported");
    },
  );
});

/** A storage declaring neither precondition capability, refusing `onlyIf` as an adapter does. */
const withoutPreconditions: PresignsPut = {
  presignPut: async (key, { onlyIf }) => {
    const refusal = preconditionRefusal(onlyIf, "write", []);

    if (refusal !== undefined) {
      throw storageError({ ...refusal, operation: "presignPut", key, attempts: 0 });
    }

    return signed;
  },
};

/** A storage whose `presignPut` rejects with `thrown`. */
const refusing = (thrown: unknown): PresignsPut => ({
  presignPut: async () => {
    throw thrown;
  },
});

describe("a `StorageError` from `presignPut`", () => {
  test.each([
    { row: "`InvalidKey`", fields: { code: "InvalidKey", key: "a/" }, status: 404 },
    { row: "`InvalidOption`", fields: { code: "InvalidOption" }, status: 500 },
    { row: "`InvalidCredentials`", fields: { code: "InvalidCredentials" }, status: 500 },
    { row: "`NetworkError`", fields: { code: "NetworkError", retryable: true }, status: 503 },
  ] as const)("$row answers $status with an empty body", async ({ fields, status }) => {
    const error = storageError({ operation: "presignPut", ...fields });
    const response = await presignUpload(refusing(error), "uploads/report.pdf", options());

    expect(response.status).toBe(status);
    expect(response.headers.has("content-type")).toBe(false);
    expect(await response.text()).toBe("");
    expect(storageErrorOf(response)).toBe(error);
  });

  test("`PreconditionFailed` answers `412` with an empty body and no `ETag`", async () => {
    const error = storageError({
      code: "PreconditionFailed",
      operation: "presignPut",
      key: "uploads/report.pdf",
      attempts: 0,
    });
    const response = await presignUpload(
      refusing(error),
      "uploads/report.pdf",
      options({ onlyIf: { etag: "e1" } }),
    );

    expect(response.status).toBe(412);
    expect(response.headers.has("etag")).toBe(false);
    expect(await response.text()).toBe("");
    expect(storageErrorOf(response)).toBe(error);
  });

  test("anything else thrown is thrown on", async () => {
    const thrown = new TypeError("storage.presignPut is not a function");

    await expect(presignUpload(refusing(thrown), "uploads/report.pdf", options())).rejects.toBe(
      thrown,
    );
  });
});
