import { assert, assertSameBytes } from "../assertions.ts";
import { kibibyte, patternOf, streamOf } from "../cases/bytes.ts";
import { keyFor, prefixFor } from "../cases/keys.ts";
import type { HttpConformanceCase, HttpConformanceContext } from "../http-target.ts";
import { assertHeaderOf, expectEmpty, expectStatus } from "./answers.ts";

/** The `maxSize` spec 14.8 configures the `upload` route with. */
const maxSize = 1048576;

/** The chunks a streamed body is handed over in, so that it spans several reads. */
const chunkSize = 64 * kibibyte;

/** A request to the `upload` route, `PUT` unless `init` names another method. */
const upload = async (
  ctx: HttpConformanceContext,
  key: string,
  init: RequestInit = {},
): Promise<Response> => await fetch(ctx.target.url("upload", key), { method: "PUT", ...init });

/**
 * A `PUT` of a stream, which `fetch` sends without a length. Node and Deno take a stream
 * as a body only with `duplex`, which the lib does not declare, so the init is no literal
 * that the compiler would check for it.
 */
const uploadStream = async (
  ctx: HttpConformanceContext,
  key: string,
  body: ReadableStream<Uint8Array>,
): Promise<Response> => {
  const init = { method: "PUT", body, duplex: "half" };

  return await fetch(ctx.target.url("upload", key), init);
};

/** The bytes the key holds, compared with `expected`. */
async function assertHolds(
  ctx: HttpConformanceContext,
  key: string,
  expected: Uint8Array,
  what: string,
): Promise<void> {
  const stored = await ctx.storage.get(key);

  assertSameBytes(await stored.bytes(), expected, what);
}

async function assertAbsent(ctx: HttpConformanceContext, key: string, what: string): Promise<void> {
  assert(!(await ctx.storage.exists(key)), `The key holds an object after ${what}`);
}

export const uploadCases: readonly HttpConformanceCase[] = [
  {
    name: "upload/stores",
    requires: [],
    cost: "fast",
    async run(ctx) {
      const key = keyFor(ctx, "upload/stores");
      const bytes = patternOf(64 * kibibyte);
      const what = "`PUT` of 64 KiB as `text/plain`";
      const response = await upload(ctx, key, {
        headers: { "content-type": "text/plain" },
        body: bytes,
      });

      await expectEmpty(response, 201, what);

      const stat = await ctx.storage.stat(key);

      // Spec 10.5: the `etag` of `put` as a strong tag, and none derived where it has none.
      assertHeaderOf(response, "etag", stat.etag === undefined ? null : `"${stat.etag}"`, what);
      assert(
        stat.contentType === "text/plain",
        `\`stat\` reports the content type ${JSON.stringify(stat.contentType)} for what the \`PUT\` of \`text/plain\` stored`,
      );
      await assertHolds(ctx, key, bytes, "The object the `PUT` stored");
    },
  },
  {
    name: "upload/streamed-body",
    requires: [],
    cost: "fast",
    async run(ctx) {
      const key = keyFor(ctx, "upload/streamed-body");
      const bytes = patternOf(512 * kibibyte);
      const response = await uploadStream(ctx, key, streamOf(bytes, chunkSize));

      await expectStatus(response, 201, "`PUT` of a 512 KiB stream without a length");
      await assertHolds(ctx, key, bytes, "The object the streamed `PUT` stored");
    },
  },
  {
    name: "upload/content-type-default",
    requires: [],
    cost: "fast",
    async run(ctx) {
      const key = keyFor(ctx, "upload/content-type-default");
      // A `Uint8Array` is sent without the `Content-Type` that `fetch` gives a string.
      const response = await upload(ctx, key, { body: patternOf(16) });

      await expectStatus(response, 201, "`PUT` without `Content-Type`");

      const stat = await ctx.storage.stat(key);

      assert(
        stat.contentType === "application/octet-stream",
        `\`stat\` reports the content type ${JSON.stringify(stat.contentType)} for a \`PUT\` without \`Content-Type\`, and not "application/octet-stream"`,
      );
    },
  },
  {
    name: "upload/empty-body",
    requires: [],
    cost: "fast",
    async run(ctx) {
      const key = keyFor(ctx, "upload/empty-body");

      await expectStatus(await upload(ctx, key), 201, "`PUT` without a body");

      const stat = await ctx.storage.stat(key);

      assert(stat.size === 0, `\`stat\` reports ${stat.size} bytes for a \`PUT\` without a body`);
    },
  },
  {
    name: "upload/overwrites",
    requires: [],
    cost: "fast",
    async run(ctx) {
      const key = keyFor(ctx, "upload/overwrites");
      const second = patternOf(16, 1);

      await expectStatus(await upload(ctx, key, { body: patternOf(16) }), 201, "The first `PUT`");
      await expectStatus(await upload(ctx, key, { body: second }), 201, "The second `PUT`");
      await assertHolds(ctx, key, second, "The object after the second `PUT`");
    },
  },
  {
    name: "upload/max-size",
    requires: [],
    cost: "fast",
    async run(ctx) {
      const largest = patternOf(maxSize);

      await expectStatus(
        await upload(ctx, keyFor(ctx, "upload/max-size", "largest"), { body: largest }),
        201,
        `\`PUT\` of ${maxSize} bytes`,
      );

      const key = keyFor(ctx, "upload/max-size", "stored");
      const stored = patternOf(16);
      const tooLarge = patternOf(maxSize + 1, 1);

      await ctx.storage.put(key, stored, { contentType: "text/plain" });

      await expectEmpty(
        await upload(ctx, key, { body: tooLarge }),
        413,
        `\`PUT\` of ${maxSize + 1} bytes`,
      );
      await expectEmpty(
        await uploadStream(ctx, key, streamOf(tooLarge, chunkSize)),
        413,
        `\`PUT\` of a stream of ${maxSize + 1} bytes without a length`,
      );
      await assertHolds(ctx, key, stored, "The object after the refused `PUT`s");
    },
  },
  {
    name: "upload/content-encoding",
    requires: [],
    cost: "fast",
    async run(ctx) {
      const key = keyFor(ctx, "upload/content-encoding");
      const response = await upload(ctx, key, {
        headers: { "content-encoding": "gzip" },
        body: patternOf(16),
      });

      await expectEmpty(response, 415, "`PUT` with `Content-Encoding: gzip`");
      await assertAbsent(ctx, key, "the `415`");
    },
  },
  {
    name: "upload/method-not-allowed",
    requires: [],
    cost: "fast",
    async run(ctx) {
      const key = keyFor(ctx, "upload/method-not-allowed");

      for (const [method, body] of [
        ["POST", patternOf(16)],
        ["GET", undefined],
      ] as const) {
        const what = `\`${method}\``;
        // oxlint-disable-next-line no-await-in-loop -- one request after the other
        const response = await upload(ctx, key, { method, body });

        // oxlint-disable-next-line no-await-in-loop -- one request after the other
        await expectStatus(response, 405, what);
        assertHeaderOf(response, "allow", "PUT", what);
      }

      await assertAbsent(ctx, key, "the `405`s");
    },
  },
  {
    name: "upload/invalid-key",
    requires: [],
    cost: "fast",
    async run(ctx) {
      const key = `${prefixFor(ctx, "upload/invalid-key")}a/`;

      // Spec 10.2: no object can live under an invalid key, and a `400` would tell the
      // client the key rules.
      await expectEmpty(await upload(ctx, key, { body: patternOf(16) }), 404, "`PUT` under `a/`");
    },
  },
  {
    name: "upload/no-header-metadata",
    requires: [],
    cost: "fast",
    async run(ctx) {
      const key = keyFor(ctx, "upload/no-header-metadata");
      const response = await upload(ctx, key, {
        headers: { "x-amz-meta-a": "1", "x-ms-meta-a": "1" },
        body: patternOf(16),
      });

      await expectStatus(response, 201, "`PUT` with `x-amz-meta-a` and `x-ms-meta-a`");

      const stat = await ctx.storage.stat(key);

      assert(
        Object.keys(stat.userMetadata).length === 0,
        `\`stat\` reports the user metadata ${JSON.stringify(stat.userMetadata)} that request headers named`,
      );
    },
  },
];
