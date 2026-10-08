import type { ContentHeaders, ObjectStat } from "@stowage/core";

import { assertSameBytes } from "../assertions.ts";
import { patternOf } from "../cases/bytes.ts";
import { keyFor, prefixFor } from "../cases/keys.ts";
import type { HttpConformanceCase, HttpConformanceContext } from "../http-target.ts";
import { assertHeaderOf, expectEmpty, expectStatus } from "./answers.ts";

/** Spec 14.9 serves a 16-byte object, which its range cases count into. */
const objectSize = 16;

/**
 * The headers spec 10.3 gives a `200` and a `HEAD` alike, which `serve/head` compares.
 * `Last-Modified` is held against `stat` instead: where the provider's clock runs ahead,
 * each answer caps it at its own `Date`, and two answers a second apart differ.
 */
const objectHeaderNames: readonly string[] = [
  "content-type",
  "x-content-type-options",
  "content-disposition",
  "cache-control",
  "etag",
  "accept-ranges",
];

const serve = async (
  ctx: HttpConformanceContext,
  key: string,
  init?: RequestInit,
): Promise<Response> => await fetch(ctx.target.url("serve", key), init);

/** An object of its own for one case, written through the storage behind the server. */
async function seed(
  ctx: HttpConformanceContext,
  key: string,
  contentHeaders: ContentHeaders = {},
): Promise<Uint8Array> {
  const bytes = patternOf(objectSize);

  await ctx.storage.put(key, bytes, { contentType: "text/plain", ...contentHeaders });

  return bytes;
}

/** The `Content-Disposition` spec 10.3 gives a key whose last segment `name` is plain ASCII. */
const dispositionNamed = (name: string): string =>
  `attachment; filename="${name}"; filename*=UTF-8''${name}`;

/** The ranges `serve/range` asks for, each with the first and last byte it is answered with. */
const satisfiableRanges = [
  ["bytes=2-5", 2, 5],
  ["bytes=4-", 4, 15],
  // Spec 4.3 clips an end beyond the size, and the answer names the clipped one.
  ["bytes=2-999", 2, 15],
] as const;

const suffixRange = "bytes=-3";

const unsatisfiableRange = `bytes=${objectSize}-`;

/** A `GET` with `headers`, named as written, and the words its assertions name it by. */
async function serveWith(
  ctx: HttpConformanceContext,
  key: string,
  headers: Readonly<Record<string, string>>,
): Promise<{ response: Response; what: string }> {
  const fields = Object.entries(headers).map(([name, value]) => `\`${name}: ${value}\``);

  return {
    response: await serve(ctx, key, { headers }),
    what: `\`GET\` with ${fields.join(" and ")}`,
  };
}

const serveRange = async (
  ctx: HttpConformanceContext,
  key: string,
  range: string,
): Promise<{ response: Response; what: string }> => await serveWith(ctx, key, { Range: range });

/** A tag no object of the suite carries. */
const otherTag = '"stowage-other"';

/**
 * The validators a client holds after a first `GET`, as spec 14.9 has the date cases send
 * them. Where the provider's clock runs ahead, a server caps `Last-Modified` at its `Date`
 * (spec 10.3), and the next answer's cap lies later: the `Last-Modified` sent back would then
 * read as older than the object. So `modified` is `lastModified` at whole seconds, which no
 * cap exceeds, and `secondBefore` a second before the `Last-Modified` of the first `GET`,
 * which every later cap exceeds.
 */
async function validatorsOf(
  ctx: HttpConformanceContext,
  key: string,
): Promise<{ etag: string | null; modified: string; secondBefore: string }> {
  const stat = await ctx.storage.stat(key);
  const response = await serve(ctx, key);

  await expectStatus(response, 200, "The first `GET`");

  const lastModified = Date.parse(response.headers.get("last-modified") ?? "");

  return {
    etag: response.headers.get("etag"),
    modified: new Date(modifiedOf(stat)).toUTCString(),
    secondBefore: new Date(lastModified - second).toUTCString(),
  };
}

/** An answer of `200` with the whole object, which spec 10.3 gives a `Range` it ignores. */
async function expectWhole(response: Response, bytes: Uint8Array, what: string): Promise<void> {
  assertSameBytes(await expectStatus(response, 200, what), bytes, `The body of the ${what}`);
  assertHeaderOf(response, "content-range", null, what);
}

const second = 1000;

/** `lastModified` at whole seconds, which spec 10.3 compares dates at. */
const modifiedOf = (stat: ObjectStat): number =>
  Math.floor(stat.lastModified.getTime() / second) * second;

/**
 * `lastModified` at whole seconds as an HTTP date, or the answer's `Date` where that is
 * earlier: spec 10.3 keeps `Last-Modified` out of the server's future, and the provider's
 * clock may run ahead of the server's.
 */
function lastModifiedFor(stat: ObjectStat, response: Response): string {
  const modified = modifiedOf(stat);
  const date = Date.parse(response.headers.get("date") ?? "");

  return new Date(Number.isNaN(date) ? modified : Math.min(modified, date)).toUTCString();
}

/**
 * The `If-Range` fields `serve/if-range` sends and the answer each has: the strong `ETag`
 * lets the range through, and nothing else does, a date included (spec 10.3).
 */
async function ifRangesOf(
  ctx: HttpConformanceContext,
  key: string,
): Promise<readonly (readonly [string, "range" | "whole"])[]> {
  const { etag, modified } = await validatorsOf(ctx, key);
  const others = [
    [otherTag, "whole"],
    [modified, "whole"],
  ] as const;

  return etag === null ? others : [[etag, "range"], ...others];
}

export const serveCases: readonly HttpConformanceCase[] = [
  {
    name: "serve/whole",
    requires: [],
    cost: "fast",
    async run(ctx) {
      const key = keyFor(ctx, "serve/whole");
      const bytes = await seed(ctx, key);
      const stat = await ctx.storage.stat(key);
      const response = await serve(ctx, key);

      assertSameBytes(await expectStatus(response, 200, "`GET`"), bytes, "The body of the `GET`");
      assertHeaderOf(response, "content-type", stat.contentType, "`GET`");
      assertHeaderOf(response, "content-length", String(stat.size), "`GET`");
    },
  },
  {
    name: "serve/headers",
    requires: [],
    cost: "fast",
    async run(ctx) {
      const key = keyFor(ctx, "serve/headers");

      await seed(ctx, key);

      const stat = await ctx.storage.stat(key);
      const response = await serve(ctx, key);

      await expectStatus(response, 200, "`GET`");
      assertHeaderOf(response, "x-content-type-options", "nosniff", "`GET`");
      assertHeaderOf(response, "cache-control", "private, no-cache", "`GET`");
      assertHeaderOf(response, "etag", stat.etag === undefined ? null : `"${stat.etag}"`, "`GET`");
      assertHeaderOf(response, "last-modified", lastModifiedFor(stat, response), "`GET`");
    },
  },
  {
    name: "serve/disposition",
    requires: [],
    cost: "fast",
    async run(ctx) {
      const key = `${prefixFor(ctx, "serve/disposition")}résumé 100%.pdf`;

      await seed(ctx, key);

      const response = await serve(ctx, key);

      await expectStatus(response, 200, "`GET`");
      assertHeaderOf(
        response,
        "content-disposition",
        `attachment; filename="r_sum_ 100_.pdf"; filename*=UTF-8''r%C3%A9sum%C3%A9%20100%25.pdf`,
        "`GET`",
      );
    },
  },
  {
    name: "serve/head",
    requires: [],
    cost: "fast",
    async run(ctx) {
      const key = keyFor(ctx, "serve/head");

      await seed(ctx, key);

      const stat = await ctx.storage.stat(key);
      const get = await serve(ctx, key);

      await expectStatus(get, 200, "`GET`");

      // Spec 10.3 ignores `Range` on a `HEAD`, whether the storage reads ranges or not.
      for (const [what, headers] of [
        ["`HEAD`", {}],
        ["`HEAD` with `Range: bytes=0-1`", { range: "bytes=0-1" }],
      ] as const) {
        // oxlint-disable-next-line no-await-in-loop -- one request after the other
        const head = await serve(ctx, key, { method: "HEAD", headers });

        // oxlint-disable-next-line no-await-in-loop -- one request after the other
        await expectEmpty(head, 200, what);

        for (const name of objectHeaderNames) {
          assertHeaderOf(head, name, get.headers.get(name), what);
        }

        assertHeaderOf(head, "last-modified", lastModifiedFor(stat, head), what);
        assertHeaderOf(head, "content-length", String(stat.size), what);
      }
    },
  },
  {
    name: "serve/not-found",
    requires: [],
    cost: "fast",
    async run(ctx) {
      const absent = keyFor(ctx, "serve/not-found", "absent");
      const invalid = `${prefixFor(ctx, "serve/not-found")}a//b`;

      for (const [what, key, init] of [
        ["`GET` of a missing key", absent, {}],
        ["`HEAD` of a missing key", absent, { method: "HEAD" }],
        // Spec 10.3: a request that would be `404` without its preconditions is `404` with them.
        ["`GET` of a missing key with `If-Match: *`", absent, { headers: { "if-match": "*" } }],
        // Spec 10.2: no object can live under an invalid key, and a `400` would tell the
        // client the key rules.
        ["`GET` of the key `a//b`", invalid, {}],
      ] as const) {
        // oxlint-disable-next-line no-await-in-loop -- one request after the other
        await expectEmpty(await serve(ctx, key, init), 404, what);
      }
    },
  },
  {
    name: "serve/method-not-allowed",
    requires: [],
    cost: "fast",
    async run(ctx) {
      const key = keyFor(ctx, "serve/method-not-allowed");
      const bytes = await seed(ctx, key);

      for (const [method, body] of [
        ["POST", "replaced"],
        ["PUT", "replaced"],
        ["DELETE", undefined],
      ] as const) {
        // oxlint-disable-next-line no-await-in-loop -- one request after the other
        const response = await serve(ctx, key, { method, body });

        // oxlint-disable-next-line no-await-in-loop -- one request after the other
        await expectStatus(response, 405, `\`${method}\``);
        assertHeaderOf(response, "allow", "GET, HEAD", `\`${method}\``);
      }

      const stored = await ctx.storage.get(key);

      assertSameBytes(await stored.bytes(), bytes, "The object after the refused requests");
    },
  },
  {
    name: "serve/range",
    requires: ["rangeReads"],
    cost: "fast",
    async run(ctx) {
      const key = keyFor(ctx, "serve/range");
      const bytes = await seed(ctx, key);

      for (const [range, start, last] of satisfiableRanges) {
        // oxlint-disable-next-line no-await-in-loop -- one request after the other
        const { response, what } = await serveRange(ctx, key, range);

        assertSameBytes(
          // oxlint-disable-next-line no-await-in-loop -- one request after the other
          await expectStatus(response, 206, what),
          bytes.subarray(start, last + 1),
          `The body of the ${what}`,
        );
        assertHeaderOf(response, "content-range", `bytes ${start}-${last}/${objectSize}`, what);
        assertHeaderOf(response, "content-length", String(last - start + 1), what);
        assertHeaderOf(response, "accept-ranges", "bytes", what);
      }
    },
    async runWithout(ctx) {
      const key = keyFor(ctx, "serve/range");
      const bytes = await seed(ctx, key);

      // Spec 10.3 ignores any `Range` on a storage without `rangeReads`.
      for (const [range] of satisfiableRanges) {
        // oxlint-disable-next-line no-await-in-loop -- one request after the other
        const { response, what } = await serveRange(ctx, key, range);

        // oxlint-disable-next-line no-await-in-loop -- one request after the other
        await expectWhole(response, bytes, what);
        assertHeaderOf(response, "accept-ranges", null, what);
      }
    },
  },
  {
    name: "serve/suffix-range",
    requires: ["rangeReads"],
    cost: "fast",
    async run(ctx) {
      const key = keyFor(ctx, "serve/suffix-range");
      const bytes = await seed(ctx, key);
      const { response, what } = await serveRange(ctx, key, suffixRange);

      assertSameBytes(
        await expectStatus(response, 206, what),
        bytes.subarray(objectSize - 3),
        `The body of the ${what}`,
      );
      assertHeaderOf(response, "content-range", `bytes 13-15/${objectSize}`, what);
    },
    async runWithout(ctx) {
      const key = keyFor(ctx, "serve/suffix-range");
      const bytes = await seed(ctx, key);
      const { response, what } = await serveRange(ctx, key, suffixRange);

      await expectWhole(response, bytes, what);
    },
  },
  {
    name: "serve/unsatisfiable-range",
    requires: ["rangeReads"],
    cost: "fast",
    async run(ctx) {
      const key = keyFor(ctx, "serve/unsatisfiable-range");

      await seed(ctx, key);

      const { response, what } = await serveRange(ctx, key, unsatisfiableRange);

      await expectStatus(response, 416, what);
      assertHeaderOf(response, "content-range", `bytes */${objectSize}`, what);
    },
    async runWithout(ctx) {
      const key = keyFor(ctx, "serve/unsatisfiable-range");
      const bytes = await seed(ctx, key);
      const { response, what } = await serveRange(ctx, key, unsatisfiableRange);

      await expectWhole(response, bytes, what);
    },
  },
  {
    name: "serve/ignored-range",
    requires: [],
    cost: "fast",
    async run(ctx) {
      const key = keyFor(ctx, "serve/ignored-range");
      const bytes = await seed(ctx, key);

      // Spec 10.3 honors one range of `bytes` and ignores what HTTP lets a server ignore.
      for (const range of ["bytes=0-1,3-4", "items=0-1", "bytes=x"]) {
        const what = `\`GET\` with \`Range: ${range}\``;
        // oxlint-disable-next-line no-await-in-loop -- one request after the other
        const response = await serve(ctx, key, { headers: { range } });

        // oxlint-disable-next-line no-await-in-loop -- one request after the other
        await expectWhole(response, bytes, what);
      }
    },
  },
  {
    name: "serve/if-none-match",
    requires: [],
    cost: "fast",
    async run(ctx) {
      const key = keyFor(ctx, "serve/if-none-match");

      await seed(ctx, key);

      const { etag } = await validatorsOf(ctx, key);
      // Spec 10.3: `If-None-Match` compares weakly, and without an `etag` only `*` names
      // the object.
      const matching = etag === null ? ["*"] : [etag, `W/${etag}`, "*"];

      for (const field of matching) {
        // oxlint-disable-next-line no-await-in-loop -- one request after the other
        const { response, what } = await serveWith(ctx, key, { "If-None-Match": field });

        // oxlint-disable-next-line no-await-in-loop -- one request after the other
        await expectEmpty(response, 304, what);
      }

      if (etag !== null) {
        const { response, what } = await serveWith(ctx, key, { "If-None-Match": otherTag });

        await expectStatus(response, 200, what);
      }
    },
  },
  {
    name: "serve/if-modified-since",
    requires: [],
    cost: "fast",
    async run(ctx) {
      const key = keyFor(ctx, "serve/if-modified-since");

      await seed(ctx, key);

      const { modified, secondBefore } = await validatorsOf(ctx, key);

      for (const [headers, status] of [
        [{ "If-Modified-Since": modified }, 304],
        [{ "If-Modified-Since": secondBefore }, 200],
        // RFC 9110 13.1.3: `If-Modified-Since` counts only without `If-None-Match`.
        [{ "If-None-Match": otherTag, "If-Modified-Since": modified }, 200],
      ] as const) {
        // oxlint-disable-next-line no-await-in-loop -- one request after the other
        const { response, what } = await serveWith(ctx, key, headers);

        // oxlint-disable-next-line no-await-in-loop -- one request after the other
        await expectStatus(response, status, what);
      }
    },
  },
  {
    name: "serve/if-match",
    requires: [],
    cost: "fast",
    async run(ctx) {
      const key = keyFor(ctx, "serve/if-match");

      await seed(ctx, key);

      const { etag } = await validatorsOf(ctx, key);
      // Spec 10.3: `If-Match` compares strongly, and without an `etag` it holds for `*`
      // alone.
      const fields =
        etag === null
          ? ([
              ["*", 200],
              [otherTag, 412],
            ] as const)
          : ([
              [etag, 200],
              ["*", 200],
              [otherTag, 412],
              [`W/${etag}`, 412],
            ] as const);

      for (const [field, status] of fields) {
        // oxlint-disable-next-line no-await-in-loop -- one request after the other
        const { response, what } = await serveWith(ctx, key, { "If-Match": field });

        // oxlint-disable-next-line no-await-in-loop -- one request after the other
        await expectStatus(response, status, what);
      }
    },
  },
  {
    name: "serve/if-unmodified-since",
    requires: [],
    cost: "fast",
    async run(ctx) {
      const key = keyFor(ctx, "serve/if-unmodified-since");

      await seed(ctx, key);

      const { modified, secondBefore } = await validatorsOf(ctx, key);

      for (const [headers, status] of [
        [{ "If-Unmodified-Since": secondBefore }, 412],
        [{ "If-Unmodified-Since": modified }, 200],
        // RFC 9110 13.1.4: `If-Unmodified-Since` counts only without `If-Match`.
        [{ "If-Match": "*", "If-Unmodified-Since": secondBefore }, 200],
      ] as const) {
        // oxlint-disable-next-line no-await-in-loop -- one request after the other
        const { response, what } = await serveWith(ctx, key, headers);

        // oxlint-disable-next-line no-await-in-loop -- one request after the other
        await expectStatus(response, status, what);
      }
    },
  },
  {
    name: "serve/if-range",
    requires: ["rangeReads"],
    cost: "fast",
    async run(ctx) {
      const key = keyFor(ctx, "serve/if-range");
      const bytes = await seed(ctx, key);

      for (const [field, answer] of await ifRangesOf(ctx, key)) {
        // oxlint-disable-next-line no-await-in-loop -- one request after the other
        const { response, what } = await serveWith(ctx, key, {
          Range: "bytes=2-5",
          "If-Range": field,
        });

        if (answer === "whole") {
          // oxlint-disable-next-line no-await-in-loop -- one request after the other
          await expectWhole(response, bytes, what);
        } else {
          assertSameBytes(
            // oxlint-disable-next-line no-await-in-loop -- one request after the other
            await expectStatus(response, 206, what),
            bytes.subarray(2, 6),
            `The body of the ${what}`,
          );
        }
      }
    },
    async runWithout(ctx) {
      const key = keyFor(ctx, "serve/if-range");
      const bytes = await seed(ctx, key);

      for (const [field] of await ifRangesOf(ctx, key)) {
        // oxlint-disable-next-line no-await-in-loop -- one request after the other
        const { response, what } = await serveWith(ctx, key, {
          Range: "bytes=2-5",
          "If-Range": field,
        });

        // oxlint-disable-next-line no-await-in-loop -- one request after the other
        await expectWhole(response, bytes, what);
      }
    },
  },
  {
    name: "serve/content-language",
    requires: ["contentHeaders"],
    cost: "fast",
    async run(ctx) {
      const key = keyFor(ctx, "serve/content-language");

      await seed(ctx, key, { contentLanguage: "de-AT" });

      // Spec 10.3: a `304` carries the headers of the `200` but `Content-Length`.
      for (const [what, init, status] of [
        ["`GET`", {}, 200],
        ["`HEAD`", { method: "HEAD" }, 200],
        ["`GET` with `If-None-Match: *`", { headers: { "if-none-match": "*" } }, 304],
      ] as const) {
        // oxlint-disable-next-line no-await-in-loop -- one request after the other
        const response = await serve(ctx, key, init);

        // oxlint-disable-next-line no-await-in-loop -- one request after the other
        await expectStatus(response, status, what);
        assertHeaderOf(response, "content-language", "de-AT", what);
      }
    },
    async runWithout(ctx) {
      const key = keyFor(ctx, "serve/content-language");

      await seed(ctx, key);

      const response = await serve(ctx, key);

      await expectStatus(response, 200, "`GET`");
      assertHeaderOf(response, "content-language", null, "`GET`");
    },
  },
  {
    name: "serve/stored-disposition",
    requires: ["contentHeaders"],
    cost: "fast",
    async run(ctx) {
      const prefix = prefixFor(ctx, "serve/stored-disposition");

      // Spec 10.3 sends a stored disposition only where it is an `attachment`, and the
      // default in place of any other, so that an uploader cannot have its object rendered.
      for (const [name, stored, expected] of [
        [
          "attachment.pdf",
          'attachment; filename="stored.pdf"',
          'attachment; filename="stored.pdf"',
        ],
        ["inline.html", 'inline; filename="x.html"', dispositionNamed("inline.html")],
      ] as const) {
        const key = `${prefix}${name}`;
        const what = `\`GET\` of an object stored with \`${stored}\``;

        // oxlint-disable-next-line no-await-in-loop -- one object after the other
        await seed(ctx, key, { contentDisposition: stored });

        // oxlint-disable-next-line no-await-in-loop -- one request after the other
        const response = await serve(ctx, key);

        // oxlint-disable-next-line no-await-in-loop -- one request after the other
        await expectStatus(response, 200, what);
        assertHeaderOf(response, "content-disposition", expected, what);
      }
    },
    async runWithout(ctx) {
      const key = `${prefixFor(ctx, "serve/stored-disposition")}plain.pdf`;

      await seed(ctx, key);

      const response = await serve(ctx, key);

      await expectStatus(response, 200, "`GET`");
      assertHeaderOf(response, "content-disposition", dispositionNamed("plain.pdf"), "`GET`");
    },
  },
  {
    name: "serve/stored-cache-control",
    requires: ["contentHeaders"],
    cost: "fast",
    async run(ctx) {
      const key = keyFor(ctx, "serve/stored-cache-control");
      const what = "`GET` of an object stored with `public, max-age=60`";

      await seed(ctx, key, { cacheControl: "public, max-age=60" });

      const response = await serve(ctx, key);

      // Spec 14.8: the `serve` route passes no `storedCacheControl`, so the default stands.
      await expectStatus(response, 200, what);
      assertHeaderOf(response, "cache-control", "private, no-cache", what);
    },
    async runWithout(ctx) {
      const key = keyFor(ctx, "serve/stored-cache-control");

      await seed(ctx, key);

      const response = await serve(ctx, key);

      await expectStatus(response, 200, "`GET`");
      assertHeaderOf(response, "cache-control", "private, no-cache", "`GET`");
    },
  },
];
