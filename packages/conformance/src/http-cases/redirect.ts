import { assert, assertSameBytes } from "../assertions.ts";
import { patternOf } from "../cases/bytes.ts";
import { keyFor } from "../cases/keys.ts";
import type { HttpConformanceCase, HttpConformanceContext } from "../http-target.ts";
import { assertHeaderOf, expectEmpty, expectStatus } from "./answers.ts";

/**
 * A request to the `redirect` route that hands the `302` back rather than following it,
 * which Node, Bun and Deno answer with the redirect itself.
 */
const redirect = async (
  ctx: HttpConformanceContext,
  key: string,
  init: RequestInit = {},
): Promise<Response> =>
  await fetch(ctx.target.url("redirect", key), { ...init, redirect: "manual" });

/** The `Location` of a `302`, which spec 10.4 makes the presigned URL and so absolute. */
function locationOf(response: Response, what: string): string {
  const location = response.headers.get("location") ?? "";

  assert(URL.canParse(location), `${what} carries \`location: ${location}\`, no absolute URL`);

  return location;
}

/**
 * What every `runWithout` half of this file asserts: without `presignedUrls` there is no
 * `presignGet` to hand `redirectToObject`, which spec 10.1 makes a compile error, so the
 * route has nothing to answer and the absence is what the half reads.
 */
async function assertNoPresignGet(ctx: HttpConformanceContext): Promise<void> {
  assert(
    !("presignGet" in ctx.storage),
    "The storage declares no `presignedUrls` and carries `presignGet`",
  );
}

export const redirectCases: readonly HttpConformanceCase[] = [
  {
    name: "redirect/found",
    requires: ["presignedUrls"],
    cost: "fast",
    async run(ctx) {
      const key = keyFor(ctx, "redirect/found");
      const bytes = patternOf(16);

      await ctx.storage.put(key, bytes, { contentType: "text/plain" });

      const response = await redirect(ctx, key);
      const what = '`GET` with `redirect: "manual"`';

      await expectEmpty(response, 302, what);
      assertHeaderOf(response, "cache-control", "private, no-store", what);

      const followed = await fetch(locationOf(response, what));

      assertSameBytes(
        await expectStatus(followed, 200, "`GET` on `Location`"),
        bytes,
        "The body of the `GET` on `Location`",
      );
    },
    runWithout: assertNoPresignGet,
  },
  {
    name: "redirect/head",
    requires: ["presignedUrls"],
    cost: "fast",
    async run(ctx) {
      const key = keyFor(ctx, "redirect/head");

      await ctx.storage.put(key, patternOf(16), { contentType: "text/plain" });

      const response = await redirect(ctx, key, { method: "HEAD" });
      const what = '`HEAD` with `redirect: "manual"`';

      await expectEmpty(response, 302, what);
      locationOf(response, what);
    },
    runWithout: assertNoPresignGet,
  },
  {
    name: "redirect/method-not-allowed",
    requires: ["presignedUrls"],
    cost: "fast",
    async run(ctx) {
      const response = await redirect(ctx, keyFor(ctx, "redirect/method-not-allowed"), {
        method: "POST",
        body: "replaced",
      });

      await expectStatus(response, 405, "`POST`");
      assertHeaderOf(response, "allow", "GET, HEAD", "`POST`");
    },
    runWithout: assertNoPresignGet,
  },
];
