import { assert, assertSameBytes } from "../assertions.ts";
import { kibibyte, patternOf, streamOf } from "../cases/bytes.ts";
import { keyFor, prefixFor } from "../cases/keys.ts";
import type { HttpConformanceCase, HttpConformanceContext } from "../http-target.ts";
import {
  answerOrNetworkError,
  answerTo,
  assertHeaderOf,
  expectEmpty,
  expectStatus,
  UnansweredRequest,
} from "./answers.ts";

/** The `maxSize` spec 14.8 configures the `upload` route with. */
const maxSize = 1048576;

/** The chunks a streamed body is handed over in, so that it spans several reads. */
const chunkSize = 64 * kibibyte;

/** A request to the `upload` route, `PUT` unless `init` names another method. */
const sendUpload = async (
  ctx: HttpConformanceContext,
  key: string,
  init: RequestInit = {},
): Promise<Response> => await fetch(ctx.target.url("upload", key), { method: "PUT", ...init });

/** The answer to `sendUpload`, a network error thrown as one naming the request in `what`. */
const upload = async (
  ctx: HttpConformanceContext,
  key: string,
  what: string,
  init: RequestInit = {},
): Promise<Response> => await answerTo(sendUpload(ctx, key, init), what);

/**
 * A `PUT` of a stream, which `fetch` sends without a length. Node and Deno take a stream
 * as a body only with `duplex`, which the lib does not declare, so the init is no literal
 * that the compiler would check for it.
 */
const uploadStream = async (
  ctx: HttpConformanceContext,
  key: string,
  body: ReadableStream<Uint8Array>,
  what: string,
): Promise<Response> => {
  const init = { method: "PUT", body, duplex: "half" };

  return await answerTo(fetch(ctx.target.url("upload", key), init), what);
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

/** The `ETag` an answer carries for the object the key holds now, none where `stat` has none. */
async function assertCurrentEtag(
  ctx: HttpConformanceContext,
  key: string,
  response: Response,
  what: string,
): Promise<void> {
  const { etag } = await ctx.storage.stat(key);

  assertHeaderOf(response, "etag", etag === undefined ? null : `"${etag}"`, what);
}

/**
 * Seeds the key through the storage and answers the `etag` as a strong tag. A storage that
 * hands over none gets a tag of its own, which names no object it holds.
 */
async function seedTagged(
  ctx: HttpConformanceContext,
  key: string,
  bytes: Uint8Array,
): Promise<string> {
  const { etag } = await ctx.storage.put(key, bytes, { contentType: "text/plain" });

  return `"${etag ?? "stowage"}"`;
}

/** `PUT`s of 16 bytes under the key, each with its own headers, refused one by one with `status`. */
async function expectEachRefused(
  ctx: HttpConformanceContext,
  key: string,
  sent: readonly (readonly [what: string, headers: Record<string, string>])[],
  status: number,
): Promise<void> {
  for (const [what, headers] of sent) {
    // oxlint-disable-next-line no-await-in-loop -- one request after the other
    const response = await upload(ctx, key, what, { headers, body: patternOf(16, 9) });

    // oxlint-disable-next-line no-await-in-loop -- one request after the other
    await expectEmpty(response, status, what);
  }
}

/** A date long past, before which no object the suite seeds was written. */
const longAgo = "Thu, 01 Jan 1970 00:00:00 GMT";

export const uploadCases: readonly HttpConformanceCase[] = [
  {
    name: "upload/stores",
    requires: [],
    cost: "fast",
    async run(ctx) {
      const key = keyFor(ctx, "upload/stores");
      const bytes = patternOf(64 * kibibyte);
      const what = "`PUT` of 64 KiB as `text/plain`";
      const response = await upload(ctx, key, what, {
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
      const what = "`PUT` of a 512 KiB stream without a length";
      const response = await uploadStream(ctx, key, streamOf(bytes, chunkSize), what);

      await expectStatus(response, 201, what);
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
      const what = "`PUT` without `Content-Type`";
      const response = await upload(ctx, key, what, { body: patternOf(16) });

      await expectStatus(response, 201, what);

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

      const what = "`PUT` without a body";

      await expectStatus(await upload(ctx, key, what), 201, what);

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

      const whatFirst = "The first `PUT`";
      const whatSecond = "The second `PUT`";

      await expectStatus(
        await upload(ctx, key, whatFirst, { body: patternOf(16) }),
        201,
        whatFirst,
      );
      await expectStatus(await upload(ctx, key, whatSecond, { body: second }), 201, whatSecond);
      await assertHolds(ctx, key, second, "The object after the second `PUT`");
    },
  },
  {
    name: "upload/max-size",
    requires: [],
    cost: "fast",
    async run(ctx) {
      const largest = patternOf(maxSize);
      const whatLargest = `\`PUT\` of ${maxSize} bytes`;

      await expectStatus(
        await upload(ctx, keyFor(ctx, "upload/max-size", "largest"), whatLargest, {
          body: largest,
        }),
        201,
        whatLargest,
      );

      const key = keyFor(ctx, "upload/max-size", "stored");
      const stored = patternOf(16);
      const tooLarge = patternOf(maxSize + 1, 1);

      await ctx.storage.put(key, stored, { contentType: "text/plain" });

      const whatWithLength = `\`PUT\` of ${maxSize + 1} bytes`;
      const response = await answerOrNetworkError(
        sendUpload(ctx, key, { body: tooLarge }),
        whatWithLength,
      );

      // ADR 0056: a client still writing past the refusal may meet a reset instead of the `413`.
      if (!(response instanceof UnansweredRequest))
        await expectEmpty(response, 413, whatWithLength);

      const whatStreamed = `\`PUT\` of a stream of ${maxSize + 1} bytes without a length`;

      await expectEmpty(
        await uploadStream(ctx, key, streamOf(tooLarge, chunkSize), whatStreamed),
        413,
        whatStreamed,
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
      const what = "`PUT` with `Content-Encoding: gzip`";
      const response = await upload(ctx, key, what, {
        headers: { "content-encoding": "gzip" },
        body: patternOf(16),
      });

      await expectEmpty(response, 415, what);
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
        const response = await upload(ctx, key, what, { method, body });

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

      const what = "`PUT` under `a/`";

      // Spec 10.2: no object can live under an invalid key, and a `400` would tell the
      // client the key rules.
      await expectEmpty(await upload(ctx, key, what, { body: patternOf(16) }), 404, what);
    },
  },
  {
    name: "upload/no-header-metadata",
    requires: [],
    cost: "fast",
    async run(ctx) {
      const key = keyFor(ctx, "upload/no-header-metadata");
      const what = "`PUT` with `x-amz-meta-a` and `x-ms-meta-a`";
      const response = await upload(ctx, key, what, {
        headers: { "x-amz-meta-a": "1", "x-ms-meta-a": "1" },
        body: patternOf(16),
      });

      await expectStatus(response, 201, what);

      const stat = await ctx.storage.stat(key);

      assert(
        Object.keys(stat.userMetadata).length === 0,
        `\`stat\` reports the user metadata ${JSON.stringify(stat.userMetadata)} that request headers named`,
      );
    },
  },
  {
    name: "upload/if-none-match",
    requires: ["writeIfAbsent"],
    cost: "fast",
    async run(ctx) {
      const key = keyFor(ctx, "upload/if-none-match");
      const first = patternOf(16);
      const whatFree = "`PUT` with `If-None-Match: *` onto a free key";
      const stored = await upload(ctx, key, whatFree, {
        headers: { "if-none-match": "*" },
        body: first,
      });

      await expectEmpty(stored, 201, whatFree);
      await assertCurrentEtag(ctx, key, stored, whatFree);

      const whatHeld = "`PUT` with `If-None-Match: *` onto the key that now holds an object";
      const refused = await upload(ctx, key, whatHeld, {
        headers: { "if-none-match": "*" },
        body: patternOf(16, 1),
      });

      await expectEmpty(refused, 412, whatHeld);
      await assertHolds(ctx, key, first, "The object after the refused `PUT`");
    },
    async runWithout(ctx) {
      const key = keyFor(ctx, "upload/if-none-match");
      const what = "`PUT` with `If-None-Match: *` onto a storage without `writeIfAbsent`";

      // Spec 10.5: a precondition the client sent and the storage cannot hold is the layer's
      // `501`, before the body, and never `put`'s `Unsupported` answered `500`.
      await expectEmpty(
        await upload(ctx, key, what, { headers: { "if-none-match": "*" }, body: patternOf(16) }),
        501,
        what,
      );
      await assertAbsent(ctx, key, "the `501`");
    },
  },
  {
    name: "upload/if-match",
    requires: ["writeIfUnchanged"],
    cost: "fast",
    async run(ctx) {
      const key = keyFor(ctx, "upload/if-match");
      const whatFirst = "The first `PUT`";
      const first = await upload(ctx, key, whatFirst, { body: patternOf(16) });

      await expectStatus(first, 201, whatFirst);

      // Spec 4.4: a storage declaring `writeIfUnchanged` hands over an `etag`.
      const firstTag = first.headers.get("etag");

      assert(
        firstTag !== null,
        `${whatFirst} carries no \`ETag\` on a storage declaring \`writeIfUnchanged\``,
      );

      const replacing = patternOf(16, 1);
      const whatCurrent = "`PUT` with the `ETag` of the first `PUT` as `If-Match`";
      const replaced = await upload(ctx, key, whatCurrent, {
        headers: { "if-match": firstTag },
        body: replacing,
      });

      // ADR 0075: a write under `{ etag }` replaced an object for certain.
      await expectEmpty(replaced, 204, whatCurrent);
      await assertCurrentEtag(ctx, key, replaced, whatCurrent);
      await assertHolds(ctx, key, replacing, "The object after the `PUT` under `If-Match`");

      const currentTag = replaced.headers.get("etag") ?? "";

      await expectEachRefused(
        ctx,
        key,
        [
          [
            "`PUT` with the stale `ETag` of the first `PUT` as `If-Match`",
            { "if-match": firstTag },
          ],
          [
            "`PUT` with the current `ETag` as `W/` in `If-Match`",
            { "if-match": `W/${currentTag}` },
          ],
        ],
        412,
      );
      await assertHolds(ctx, key, replacing, "The object after the refused `PUT`s");

      const freeKey = keyFor(ctx, "upload/if-match", "free");

      await expectEachRefused(
        ctx,
        freeKey,
        [["`PUT` with `If-Match` onto a free key", { "if-match": currentTag }]],
        412,
      );
      await assertAbsent(ctx, freeKey, "the `412` under `If-Match`");
    },
    async runWithout(ctx) {
      const key = keyFor(ctx, "upload/if-match");
      const bytes = patternOf(16);
      const tag = await seedTagged(ctx, key, bytes);

      await expectEachRefused(
        ctx,
        key,
        [["`PUT` with `If-Match` onto a storage without `writeIfUnchanged`", { "if-match": tag }]],
        501,
      );
      await assertHolds(ctx, key, bytes, "The object after the `501`");
    },
  },
  {
    name: "upload/both-preconditions",
    requires: ["writeIfAbsent", "writeIfUnchanged"],
    cost: "fast",
    async run(ctx) {
      const key = keyFor(ctx, "upload/both-preconditions");
      const bytes = patternOf(16);
      const tag = await seedTagged(ctx, key, bytes);

      await expectEachRefused(
        ctx,
        key,
        [
          [
            "`PUT` with a current `If-Match` beside `If-None-Match: *`",
            { "if-match": tag, "if-none-match": "*" },
          ],
        ],
        412,
      );
      await assertHolds(ctx, key, bytes, "The object after the `412`");
    },
    async runWithout(ctx) {
      const key = keyFor(ctx, "upload/both-preconditions");
      const bytes = patternOf(16);
      const tag = await seedTagged(ctx, key, bytes);

      await expectEachRefused(
        ctx,
        key,
        [
          [
            "`PUT` with `If-Match` beside `If-None-Match: *` onto a storage without both write capabilities",
            { "if-match": tag, "if-none-match": "*" },
          ],
        ],
        501,
      );
      await assertHolds(ctx, key, bytes, "The object after the `501`");
    },
  },
  {
    name: "upload/inexpressible-precondition",
    requires: [],
    cost: "fast",
    async run(ctx) {
      const key = keyFor(ctx, "upload/inexpressible-precondition");
      const bytes = patternOf(16);
      const tag = await seedTagged(ctx, key, bytes);

      // ADR 0075: holding these would take a `stat` in front of the write, the race a
      // precondition exists to close.
      await expectEachRefused(
        ctx,
        key,
        [
          ["`PUT` with `If-Match: *`", { "if-match": "*" }],
          ["`PUT` with `If-Match` naming two tags", { "if-match": `${tag}, "other"` }],
          ["`PUT` with `If-None-Match` naming a tag", { "if-none-match": tag }],
          ["`PUT` with `If-Unmodified-Since` alone", { "if-unmodified-since": longAgo }],
        ],
        501,
      );
      await assertHolds(ctx, key, bytes, "The object after the `501`s");
    },
  },
  {
    name: "upload/malformed-precondition",
    requires: [],
    cost: "fast",
    async run(ctx) {
      const key = keyFor(ctx, "upload/malformed-precondition");
      const bytes = patternOf(16);

      await seedTagged(ctx, key, bytes);
      // Spec 10.5: the `400` comes before the `501` a storage without the write capabilities
      // would answer for the field.
      await expectEachRefused(
        ctx,
        key,
        [
          ["`PUT` with `If-Match: abc`", { "if-match": "abc" }],
          ['`PUT` with `If-None-Match: "a`', { "if-none-match": '"a' }],
        ],
        400,
      );
      await assertHolds(ctx, key, bytes, "The object after the `400`s");
    },
  },
  {
    name: "upload/ignored-preconditions",
    requires: [],
    cost: "fast",
    async run(ctx) {
      const key = keyFor(ctx, "upload/ignored-preconditions");
      const sent = [
        ["`PUT` with `If-Modified-Since` in the past", { "if-modified-since": longAgo }],
        [
          "`PUT` with `If-Modified-Since` in the future",
          { "if-modified-since": "Fri, 31 Dec 9999 23:59:59 GMT" },
        ],
        ["`PUT` with `If-Range`", { "if-range": '"stowage"' }],
      ] as const;

      for (const [index, [what, headers]] of sent.entries()) {
        const bytes = patternOf(16, index);
        // oxlint-disable-next-line no-await-in-loop -- one request after the other
        const response = await upload(ctx, key, what, { headers, body: bytes });

        // oxlint-disable-next-line no-await-in-loop -- one request after the other
        await expectStatus(response, 201, what);
        // oxlint-disable-next-line no-await-in-loop -- one request after the other
        await assertHolds(ctx, key, bytes, `The object after the ${what}`);
      }
    },
  },
];
