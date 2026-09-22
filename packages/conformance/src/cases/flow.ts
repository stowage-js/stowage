import type { ObjectEntry } from "@stowage/core";

import { assert, assertSameBytes, expectRuntimeError, expectUnsupported } from "../assertions.ts";
import type { ConformanceCaseSource } from "../case.ts";
import type { ConformanceContext } from "../target.ts";
import { mebibyte, multipartSize, patternOf, streamOf } from "./bytes.ts";
import { keyFor, prefixFor } from "./keys.ts";
import { assertNamesEachOnce, assertNothingBelow, collectEntries } from "./objects.ts";
import { assertNeitherMethod, presignLifetime, signedUrl } from "./presign.ts";

const utf8 = new TextEncoder();

/** Spec 6 has `adapter-fs` derive the content type from the key, so the two agree here. */
const contentType = "text/plain";

/** Small enough to read whole in an assertion, and long enough to hold a range within it. */
const rangedSize = 1024;

/** What the page of flow 3 holds at the most, counting a pseudo-directory as an entry. */
const pageSize = 5;

/** The tree of flow 3: seven objects, three of them one level below the listed one. */
const fileBrowserTree: readonly string[] = [
  "images/logo.txt",
  "notes/monday.txt",
  "reports/2026.txt",
  "index.txt",
  "readme.txt",
  "settings.txt",
  "wireframe.txt",
];

/** The objects flow 5 moves, below the source prefix it walks. */
const movedObjects: readonly string[] = ["one.txt", "notes/two.txt", "notes/deep/three.txt"];

export const flowCases: readonly ConformanceCaseSource[] = [
  {
    name: "flow/1-large-upload",
    requires: [],
    cost: "fast",
    async run(ctx) {
      const prefix = prefixFor(ctx, "flow/1-large-upload");
      const key = `${prefix}upload.txt`;
      const bytes = patternOf(multipartSize);

      await ctx.storage.put(key, streamOf(bytes, mebibyte), { contentType });

      const described = await ctx.storage.stat(key);

      assert(
        described.size === multipartSize,
        `\`stat\` reports ${described.size} bytes for an upload of ${multipartSize}`,
      );
      assert(
        described.contentType === contentType,
        `\`stat\` reports the content type ${JSON.stringify(described.contentType)}`,
      );
      assertSameBytes(
        await (await ctx.storage.get(key)).bytes(),
        bytes,
        "the body the upload left behind",
      );

      // The second upload is the failure flow 1 names: the caller aborts partway, and
      // what the provider already holds of it never becomes an object.
      const aborted = `${prefix}aborted.txt`;
      const controller = new AbortController();
      const body = streamOf(bytes, mebibyte, (sent) => {
        if (sent >= multipartSize / 2) controller.abort();
      });

      await expectRuntimeError(
        () => ctx.storage.put(aborted, body, { contentType, signal: controller.signal }),
        "AbortError",
      );
      assert(!(await ctx.storage.exists(aborted)), "The key of an aborted upload holds an object");
    },
  },
  {
    name: "flow/2-presigned-put",
    requires: ["presignedUrls"],
    cost: "fast",
    async run(ctx) {
      const key = keyFor(ctx, "flow/2-presigned-put", "upload.txt");
      // Flow 2 has the client report the length and the server sign that number, which
      // is the round trip ADR 0011 records in place of a range the URL would allow.
      const body = utf8.encode("the body a browser uploads to the provider");
      const url = await signedUrl(ctx, "presignPut", key, {
        expiresIn: presignLifetime,
        contentType,
        contentLength: body.byteLength,
      });
      const response = await fetch(url, {
        method: "PUT",
        body,
        headers: { "content-type": contentType },
      });

      assert(response.ok, `The upload to the signed URL was answered ${response.status}`);
      await response.arrayBuffer();

      const described = await ctx.storage.stat(key);

      assert(
        described.contentType === contentType,
        `\`stat\` reports the content type ${JSON.stringify(described.contentType)} for the upload`,
      );
      assert(
        described.size === body.byteLength,
        `\`stat\` reports ${described.size} bytes for the ${body.byteLength} that were uploaded`,
      );
    },
    runWithout: assertNeitherMethod,
  },
  {
    name: "flow/3-file-browser",
    requires: [],
    cost: "fast",
    async run(ctx) {
      const prefix = prefixFor(ctx, "flow/3-file-browser");

      await Promise.all(
        fileBrowserTree.map(async (name) => await ctx.storage.put(`${prefix}${name}`, name)),
      );

      const page = await ctx.storage.list({ prefix, delimiter: "/", pageSize }).page();

      assert(
        page.cursor !== undefined,
        `The first page of ${fileBrowserTree.length} entries carries no cursor`,
      );

      // Flow 3 has the cursor reach a fresh process, so the rest of the level is read
      // through a listing of its own rather than through the one that handed it out.
      const rest = await ctx.storage
        .list({ prefix, delimiter: "/", pageSize, cursor: page.cursor })
        .page();

      assert(rest.cursor === undefined, "The second page of the level carries a cursor");
      assertNamesEachOnce(
        [...page.objects, ...rest.objects].map((entry) => entry.key),
        levelOf(prefix),
        "The two pages of the level",
      );
      assertNamesEachOnce(
        [...page.prefixes, ...rest.prefixes],
        pseudoDirectoriesOf(prefix),
        "The pseudo-directories of the level",
      );
    },
  },
  {
    name: "flow/4-streaming-download",
    requires: ["rangeReads"],
    cost: "fast",
    async run(ctx) {
      const key = keyFor(ctx, "flow/4-streaming-download", "object.txt");
      const bytes = patternOf(rangedSize);

      await ctx.storage.put(key, bytes, { contentType });

      const stored = await ctx.storage.get(key, { range: { start: 100, end: 199 } });
      // Flow 4 passes the body on to the client without holding it, which is the stream
      // going into a `Response` unread and the content type going into its header.
      const answer = answerWith(stored.stream(), stored.stat.contentType);

      assertHeader(answer, contentType);
      assertSameBytes(
        new Uint8Array(await answer.arrayBuffer()),
        bytes.subarray(100, 200),
        "the range the answer carried",
      );
    },
    async runWithout(ctx) {
      const key = keyFor(ctx, "flow/4-streaming-download", "object.txt");
      const bytes = patternOf(rangedSize);

      await ctx.storage.put(key, bytes, { contentType });

      const stored = await ctx.storage.get(key);
      const answer = answerWith(stored.stream(), stored.stat.contentType);

      assertHeader(answer, contentType);
      assertSameBytes(
        new Uint8Array(await answer.arrayBuffer()),
        bytes,
        "the object the answer carried whole",
      );
      await expectUnsupported(
        () => ctx.storage.get(key, { range: { start: 100, end: 199 } }),
        "rangeReads",
      );
    },
  },
  {
    name: "flow/5-prefix-move",
    requires: [],
    cost: "fast",
    async run(ctx) {
      const prefix = prefixFor(ctx, "flow/5-prefix-move");
      const from = `${prefix}source/`;
      const to = `${prefix}target/`;

      await Promise.all(
        movedObjects.map(
          async (name) => await ctx.storage.put(`${from}${name}`, name, { contentType }),
        ),
      );

      const moved = await collectEntries(ctx.storage.list({ prefix: from }));

      // The loop is the caller's (spec 3): what the API owes is that the stream out of
      // `get` is a body `put` takes, with nothing holding the object whole in between.
      for (const entry of moved) {
        // oxlint-disable-next-line no-await-in-loop -- one object streams into the next
        const stored = await ctx.storage.get(entry.key);

        // oxlint-disable-next-line no-await-in-loop -- what bounds the objects in flight
        await ctx.storage.put(`${to}${entry.key.slice(from.length)}`, stored.stream(), {
          contentType: stored.stat.contentType,
        });
      }

      const report = await ctx.storage.deleteAll(from);

      assert(
        report.requested === movedObjects.length,
        `\`deleteAll\` reports ${report.requested} of the ${movedObjects.length} objects that moved`,
      );
      assert(
        report.failed.length === 0,
        `\`deleteAll\` reports ${report.failed.length} objects it could not delete`,
      );
      await assertNothingBelow(ctx, from);

      const listed = await collectEntries(ctx.storage.list({ prefix: to }));

      assertNamesEachOnce(
        listed.map((entry) => entry.key),
        movedObjects.map((name) => `${to}${name}`),
        "The listing below the target prefix",
      );
      await assertSameBodies(ctx, listed, to);
    },
  },
];

/** The objects of the listed level, which are the keys of the tree holding no delimiter. */
function levelOf(prefix: string): readonly string[] {
  return fileBrowserTree.filter((name) => !name.includes("/")).map((name) => `${prefix}${name}`);
}

function pseudoDirectoriesOf(prefix: string): readonly string[] {
  const directories = fileBrowserTree
    .filter((name) => name.includes("/"))
    .map((name) => `${prefix}${name.slice(0, name.indexOf("/") + 1)}`);

  return [...new Set(directories)];
}

/** The answer flow 4 builds out of the stored object, which nothing reads in between. */
function answerWith(body: ReadableStream<Uint8Array>, type: string): Response {
  return new Response(body, { headers: { "content-type": type } });
}

function assertHeader(answer: Response, expected: string): void {
  const held = answer.headers.get("content-type");

  assert(
    held === expected,
    `The answer reports \`content-type: ${JSON.stringify(held)}\` and not ${JSON.stringify(expected)}`,
  );
}

/** That every object arrived below the target prefix as it was written, name for name. */
async function assertSameBodies(
  ctx: ConformanceContext,
  listed: readonly ObjectEntry[],
  to: string,
): Promise<void> {
  await Promise.all(
    listed.map(async (entry) => {
      const stored = await ctx.storage.get(entry.key);

      assert(
        stored.stat.contentType === contentType,
        `The moved object under ${JSON.stringify(entry.key)} reports the content type ${JSON.stringify(stored.stat.contentType)}`,
      );
      assertSameBytes(
        await stored.bytes(),
        utf8.encode(entry.key.slice(to.length)),
        `The moved object under ${JSON.stringify(entry.key)}`,
      );
    }),
  );
}
