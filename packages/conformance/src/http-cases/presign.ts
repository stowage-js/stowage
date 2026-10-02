import { assert } from "../assertions.ts";
import { patternOf } from "../cases/bytes.ts";
import { keyFor, prefixFor } from "../cases/keys.ts";
import type { HttpConformanceCase, HttpConformanceContext } from "../http-target.ts";
import { assertHeaderOf, expectEmpty, expectStatus } from "./answers.ts";

/** The `maxSize` spec 14.8 configures the `presign` route with. */
const maxSize = 1048576;

/** The JSON body spec 14.8 has the `presign` route read, holding what a client sent as given. */
interface PresignValues {
  readonly contentType: unknown;
  readonly contentLength: unknown;
}

/**
 * A `POST` to the `presign` route with the JSON body spec 14.8 has the route read. The
 * values travel as given, so that a case can send what no type would let it.
 */
const presign = async (
  ctx: HttpConformanceContext,
  key: string,
  values: PresignValues,
): Promise<Response> =>
  await fetch(ctx.target.url("presign", key), {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(values),
  });

/** The `{ url, method, headers }` spec 10.6 has a signed upload answer with, and nothing else. */
function presignedPutOf(body: Uint8Array, what: string): { url: string; headers: Headers } {
  const text = new TextDecoder().decode(body);
  let parsed: unknown;

  try {
    parsed = JSON.parse(text);
  } catch {
    throw new Error(`${what} answers with ${JSON.stringify(text)}, no JSON`);
  }

  assert(
    typeof parsed === "object" && parsed !== null && !Array.isArray(parsed),
    `${what} answers with ${text}, no object`,
  );

  // oxlint-disable-next-line no-unsafe-type-assertion -- an object, each field checked below
  const { url, method, headers, ...more } = parsed as Record<string, unknown>;

  assert(
    Object.keys(more).length === 0,
    `${what} answers with ${Object.keys(more).join(", ")} beside \`url\`, \`method\` and \`headers\``,
  );
  assert(
    typeof url === "string" && URL.canParse(url),
    `${what} answers with \`url\` ${String(url)}, no absolute URL`,
  );
  assert(
    method === "PUT",
    `${what} answers with \`method\` ${JSON.stringify(method)} and not "PUT"`,
  );
  assert(
    typeof headers === "object" &&
      headers !== null &&
      Object.values(headers).every((value) => typeof value === "string"),
    `${what} answers with \`headers\` ${JSON.stringify(headers)}, no object of strings`,
  );

  // oxlint-disable-next-line no-unsafe-type-assertion -- checked above to hold strings alone
  return { url, headers: new Headers(headers as Record<string, string>) };
}

/**
 * What every `runWithout` half of this file asserts: without `presignedUrls` there is no
 * `presignPut` to hand `presignUpload`, which spec 10.1 makes a compile error, so the
 * route has nothing to answer and the absence is what the half reads.
 */
async function assertNoPresignPut(ctx: HttpConformanceContext): Promise<void> {
  assert(
    !("presignPut" in ctx.storage),
    "The storage declares no `presignedUrls` and carries `presignPut`",
  );
}

/** One refusal of spec 10.6 per value, each of the layer's own and so with an empty body. */
async function expectRefused(
  ctx: HttpConformanceContext,
  caseName: string,
  status: number,
  sent: readonly (readonly [string, PresignValues])[],
): Promise<void> {
  const key = keyFor(ctx, caseName);

  for (const [what, values] of sent) {
    // oxlint-disable-next-line no-await-in-loop -- one request after the other
    await expectEmpty(await presign(ctx, key, values), status, what);
  }
}

export const presignCases: readonly HttpConformanceCase[] = [
  {
    name: "presign/put",
    requires: ["presignedUrls"],
    cost: "fast",
    async run(ctx) {
      const key = keyFor(ctx, "presign/put");
      const bytes = patternOf(11);
      const what = "`POST` of `text/plain` and 11 bytes";
      const response = await presign(ctx, key, { contentType: "text/plain", contentLength: 11 });
      const body = await expectStatus(response, 200, what);

      assertHeaderOf(response, "content-type", "application/json", what);
      assertHeaderOf(response, "cache-control", "private, no-store", what);

      const { url, headers } = presignedPutOf(body, what);
      const uploaded = await fetch(url, { method: "PUT", headers, body: bytes });

      await uploaded.arrayBuffer();
      assert(uploaded.ok, `\`PUT\` on the presigned URL answers ${uploaded.status} and not 2xx`);

      const stat = await ctx.storage.stat(key);

      assert(
        stat.contentType === "text/plain",
        `\`stat\` reports the content type ${JSON.stringify(stat.contentType)} for what the presigned \`PUT\` wrote`,
      );
      assert(
        stat.size === 11,
        `\`stat\` reports ${stat.size} bytes for the 11 the presigned \`PUT\` wrote`,
      );
    },
    runWithout: assertNoPresignPut,
  },
  {
    name: "presign/method-not-allowed",
    requires: ["presignedUrls"],
    cost: "fast",
    async run(ctx) {
      const key = keyFor(ctx, "presign/method-not-allowed");

      for (const [method, body] of [
        ["GET", undefined],
        ["HEAD", undefined],
        ["PUT", "stored"],
        ["DELETE", undefined],
      ] as const) {
        const what = `\`${method}\``;
        // oxlint-disable-next-line no-await-in-loop -- one request after the other
        const response = await fetch(ctx.target.url("presign", key), { method, body });

        // oxlint-disable-next-line no-await-in-loop -- one request after the other
        await expectStatus(response, 405, what);
        assertHeaderOf(response, "allow", "POST", what);
      }

      assert(!(await ctx.storage.exists(key)), "The key holds an object after the `405`s");
    },
    runWithout: assertNoPresignPut,
  },
  {
    name: "presign/too-large",
    requires: ["presignedUrls"],
    cost: "fast",
    async run(ctx) {
      await expectRefused(ctx, "presign/too-large", 413, [
        [
          `\`contentLength\` ${maxSize + 1}`,
          { contentType: "text/plain", contentLength: maxSize + 1 },
        ],
      ]);
    },
    runWithout: assertNoPresignPut,
  },
  {
    name: "presign/invalid-length",
    requires: ["presignedUrls"],
    cost: "fast",
    async run(ctx) {
      await expectRefused(
        ctx,
        "presign/invalid-length",
        400,
        [-1, 1.5, "11"].map((contentLength) => [
          `\`contentLength\` ${JSON.stringify(contentLength)}`,
          { contentType: "text/plain", contentLength },
        ]),
      );
    },
    runWithout: assertNoPresignPut,
  },
  {
    name: "presign/invalid-content-type",
    requires: ["presignedUrls"],
    cost: "fast",
    async run(ctx) {
      await expectRefused(
        ctx,
        "presign/invalid-content-type",
        400,
        ["", "a\nb"].map((contentType) => [
          `\`contentType\` ${JSON.stringify(contentType)}`,
          { contentType, contentLength: 11 },
        ]),
      );
    },
    runWithout: assertNoPresignPut,
  },
  {
    name: "presign/invalid-key",
    requires: ["presignedUrls"],
    cost: "fast",
    async run(ctx) {
      const key = `${prefixFor(ctx, "presign/invalid-key")}a/`;
      const response = await presign(ctx, key, { contentType: "text/plain", contentLength: 11 });

      // Spec 10.2: no object can live under an invalid key, and a `400` would tell the
      // client the key rules.
      await expectEmpty(response, 404, "`POST` for the key `a/`");
    },
    runWithout: assertNoPresignPut,
  },
];
