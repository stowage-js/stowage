import type { ContentHeaders, ObjectStat, PresignedPut, Storage } from "@stowage/core";

import { assert, assertHeader, assertSameBytes, expectStorageError } from "../assertions.ts";
import type { ConformanceCaseSource } from "../case.ts";
import type { ConformanceContext } from "../target.ts";
import { keyFor } from "./keys.ts";
import { textContentType } from "./objects.ts";

const utf8 = new TextEncoder();

/** Long enough for the case to call the URL, and far below the ceiling of spec 7.10. */
export const presignLifetime: number = 300;

/** The lifetime of the URL `presign/expired-url` lets run out. */
export const expiredLifetime: number = 1;

/** Past the second `presign/expired-url` signs for, which is what spec 14.5 waits out. */
export const pastTheLifetime: number = 2000;

/**
 * The control URL `presign/expired-url` signs beside the expired one, far past the wait, so
 * that only the lifetime tells the two apart. It keeps a URL broken for another reason, such
 * as `400 MalformedSecurityHeader`, from passing as expired (spec 14.5, ADR 0035).
 */
export const controlLifetime: number = 60;

/** GCS answers an expired signature `400 ExpiredToken`, S3, R2 and Azure `403` (spec 9.9). */
const expiredStatuses: readonly number[] = [400, 403];

/** The seconds spec 7.10 allows `expiresIn`, which the two refused values sit outside. */
const refusedLifetimes: readonly number[] = [0, 604_801];

/**
 * Spec 4.9 has `presignedUrls` add two methods to the concrete type rather than change a
 * behavior, so `Storage` carries neither and the suite reads them off the storage it was
 * handed (ADR 0011). What a storage declaring the capability owes is that they are there.
 */
export type PresignName = "presignGet" | "presignPut";

const presignNames: readonly PresignName[] = ["presignGet", "presignPut"];

export interface PresignOptions extends ContentHeaders {
  readonly expiresIn: number;
  readonly contentType?: string;
  readonly contentLength?: number;
}

type ContentHeaderOption = keyof ContentHeaders;

const contentHeaderOptions: readonly ContentHeaderOption[] = [
  "cacheControl",
  "contentDisposition",
  "contentLanguage",
];

/**
 * What the content header cases sign. Each value is one the others do not hold, so that the
 * case finds it in `headers` under whatever name the adapter hands it back (spec 4.13). None
 * holds a run of spaces, which every binding admits in place of one (ADR 0063).
 */
const signedHeaders: Required<ContentHeaders> = {
  cacheControl: "public, max-age=60, immutable",
  contentDisposition: 'attachment; filename="presigned report.pdf"',
  contentLanguage: "de-AT, en",
};

/** What a differing upload sends in place of each signed value. */
const differingHeaders: Required<ContentHeaders> = {
  cacheControl: "public, max-age=61, immutable",
  contentDisposition: 'attachment; filename="another report.pdf"',
  contentLanguage: "de-CH, en",
};

export const presignCases: readonly ConformanceCaseSource[] = [
  {
    name: "presign/get",
    requires: ["presignedUrls"],
    cost: "fast",
    async run(ctx) {
      const key = keyFor(ctx, "presign/get", "object.txt");
      const body = "the body a signed `GET` hands out";

      await ctx.storage.put(key, body, { contentType: textContentType });

      const response = await fetch(await presignedGet(ctx, key, { expiresIn: presignLifetime }));

      assertStatus(response.status, 200, "`fetch` on a signed `GET`");
      assertHeader(response, "content-type", textContentType);
      assertSameBytes(
        new Uint8Array(await response.arrayBuffer()),
        utf8.encode(body),
        "the body a signed `GET` answered with",
      );
    },
    runWithout: assertNeitherMethod,
  },
  {
    name: "presign/put",
    requires: ["presignedUrls"],
    cost: "fast",
    async run(ctx) {
      const key = keyFor(ctx, "presign/put", "object.txt");
      const body = utf8.encode("the body a signed `PUT` takes");
      const { url, headers } = await presignedPut(ctx, key, {
        expiresIn: presignLifetime,
        contentType: textContentType,
        contentLength: body.byteLength,
      });
      const response = await fetch(url, { method: "PUT", body, headers });

      assert(
        response.ok,
        `\`fetch\` on a signed \`PUT\` answered ${response.status} and not a success`,
      );
      await response.arrayBuffer();

      const described = await ctx.storage.stat(key);

      assert(
        described.contentType === textContentType,
        `\`stat\` reports the content type ${JSON.stringify(described.contentType)} for what a signed \`PUT\` wrote`,
      );
      assert(
        described.size === body.byteLength,
        `\`stat\` reports ${described.size} bytes for the ${body.byteLength} a signed \`PUT\` wrote`,
      );
    },
    runWithout: assertNeitherMethod,
  },
  {
    name: "presign/expires-in-bounds",
    requires: ["presignedUrls"],
    cost: "fast",
    async run(ctx) {
      const key = keyFor(ctx, "presign/expires-in-bounds", "object.txt");

      for (const name of presignNames) {
        for (const expiresIn of refusedLifetimes) {
          // oxlint-disable-next-line no-await-in-loop -- one storage, so the calls go in turn
          await expectStorageError(
            async () => await presignerOf(ctx.storage, name)(key, lifetimeOptions(name, expiresIn)),
            { code: "InvalidOption" },
            `\`${name}\` with an \`expiresIn\` of ${expiresIn}`,
          );
        }
      }

      // Spec 7.10 has neither method send a request, so a refused lifetime is a refusal
      // before the signature and not an upload the provider answered.
      assert(
        !(await ctx.storage.exists(key)),
        "A signature the lifetime was refused for wrote the object after all",
      );
    },
    runWithout: assertNeitherMethod,
  },
  {
    name: "presign/put-rejects-type",
    requires: ["presignedUrls"],
    cost: "slow",
    async run(ctx) {
      const key = keyFor(ctx, "presign/put-rejects-type", "object.txt");
      const body = utf8.encode("a body of another type than the signature binds");
      const presigned = await presignedPut(ctx, key, {
        expiresIn: presignLifetime,
        contentType: textContentType,
        contentLength: body.byteLength,
      });
      // `Headers` and not a spread, so that the type replaces the one handed back whatever
      // case the adapter wrote its name in.
      const headers = new Headers(presigned.headers);

      headers.set("content-type", "application/json");

      // Spec 7.10 binds the content type through a signed header, so the provider rebuilds
      // another signature for this request and refuses it (ADR 0011).
      const response = await fetch(presigned.url, { method: "PUT", body, headers });

      assertStatus(await statusOf(response), 403, "a signed `PUT` carrying another content type");
    },
    runWithout: assertNeitherMethod,
  },
  {
    name: "presign/put-rejects-length",
    requires: ["presignedUrls"],
    cost: "slow",
    async run(ctx) {
      const key = keyFor(ctx, "presign/put-rejects-length", "object.txt");
      const body = utf8.encode("a body longer than the signature binds");
      const { url, headers } = await presignedPut(ctx, key, {
        expiresIn: presignLifetime,
        contentType: textContentType,
        contentLength: body.byteLength - 1,
      });
      const response = await fetch(url, { method: "PUT", body, headers });
      // The length is body framing rather than the signature, which is why the row states
      // the class of the answer and not the one status a signature mismatch produces.
      const status = await statusOf(response);

      assert(
        status >= 400 && status < 500,
        `A signed \`PUT\` carrying another length was answered ${status} and not refused`,
      );
    },
    runWithout: assertNeitherMethod,
  },
  {
    name: "presign/expired-url",
    requires: ["presignedUrls"],
    cost: "slow",
    async run(ctx) {
      const key = keyFor(ctx, "presign/expired-url", "object.txt");

      // The object is there, so that the refusal is the lifetime running out and not the
      // key being absent.
      await ctx.storage.put(key, "the body the URL stops handing out", {
        contentType: textContentType,
      });

      const expired = await presignedGet(ctx, key, { expiresIn: expiredLifetime });
      const control = await presignedGet(ctx, key, { expiresIn: controlLifetime });

      await delay(pastTheLifetime);

      assertStatus(
        await statusOf(await fetch(expired)),
        expiredStatuses,
        "a signed `GET` that has expired",
      );
      assertStatus(
        await statusOf(await fetch(control)),
        200,
        `the signed \`GET\` for ${controlLifetime} seconds beside it`,
      );
    },
    runWithout: assertNeitherMethod,
  },
  {
    name: "presign/put-content-headers",
    requires: ["presignedUrls", "contentHeaders"],
    cost: "fast",
    async run(ctx) {
      const key = keyFor(ctx, "presign/put-content-headers", "object.txt");
      const body = utf8.encode("the body a signed `PUT` stores the content headers with");
      const { url, headers } = await presignedPut(ctx, key, {
        expiresIn: presignLifetime,
        contentType: textContentType,
        contentLength: body.byteLength,
        ...signedHeaders,
      });
      const response = await fetch(url, { method: "PUT", body, headers });

      assert(
        response.ok,
        `\`fetch\` on a signed \`PUT\` carrying the content headers answered ${response.status} and not a success`,
      );
      await response.arrayBuffer();

      assertHoldsSignedHeaders(await ctx.storage.stat(key));
    },
    runWithout: assertWithoutContentHeaders,
  },
  {
    name: "presign/put-rejects-content-headers",
    requires: ["presignedUrls", "contentHeaders"],
    cost: "slow",
    async run(ctx) {
      const key = keyFor(ctx, "presign/put-rejects-content-headers", "object.txt");
      const body = utf8.encode("a body whose content headers deviate from the signed ones");
      const presigned = await presignedPut(ctx, key, {
        expiresIn: presignLifetime,
        contentType: textContentType,
        contentLength: body.byteLength,
        ...signedHeaders,
      });
      const deviations = contentHeaderOptions.flatMap((option) => {
        const name = nameCarrying(presigned, option);

        return [
          { what: `another \`${option}\``, name, value: differingHeaders[option] },
          { what: `no \`${option}\``, name, value: undefined },
        ];
      });

      for (const { what, name, value } of deviations) {
        const headers = new Headers(presigned.headers);

        if (value === undefined) headers.delete(name);
        else headers.set(name, value);

        // AWS, R2 and Azure answer `403` and GCS `400` for a missing signed header, so the
        // row states the class of the answer (spec 14.5, ADR 0064).
        // oxlint-disable-next-line no-await-in-loop -- one key, so the uploads go in turn
        const status = await statusOf(await fetch(presigned.url, { method: "PUT", body, headers }));

        assert(
          status >= 400 && status < 500,
          `A signed \`PUT\` carrying ${what} was answered ${status} and not refused`,
        );
      }
    },
    runWithout: assertWithoutContentHeaders,
  },
];

/**
 * The half of both content header cases: without `presignedUrls` the methods are absent, and
 * with it a `presignPut` carrying any one of the three is `Unsupported` naming
 * `contentHeaders` while one carrying none still signs (spec 14.5, ADR 0064).
 */
async function assertWithoutContentHeaders(ctx: ConformanceContext): Promise<void> {
  if (!ctx.declares("presignedUrls")) {
    await assertNeitherMethod(ctx);

    return;
  }

  const key = keyFor(ctx, "presign/content-headers-undeclared", "object.txt");
  const plain = { expiresIn: presignLifetime, contentType: textContentType, contentLength: 0 };

  await Promise.all(
    contentHeaderOptions.map(
      async (option) =>
        await expectStorageError(
          async () => await presignedPut(ctx, key, { ...plain, [option]: signedHeaders[option] }),
          { code: "Unsupported", capability: "contentHeaders", attempts: 0 },
          `\`presignPut\` with \`${option}\` on a storage without \`contentHeaders\``,
        ),
    ),
  );
  await presignedPut(ctx, key, plain);
}

/** The name `headers` carries the signed value of `option` under, whatever the provider's. */
function nameCarrying(presigned: PresignedPut, option: ContentHeaderOption): string {
  const carrying = Object.entries(presigned.headers).find(
    ([, value]) => value === signedHeaders[option],
  );

  assert(
    carrying !== undefined,
    `\`presignPut\` handed back no header carrying the signed \`${option}\``,
  );

  return carrying[0];
}

function assertHoldsSignedHeaders(described: ObjectStat): void {
  for (const option of contentHeaderOptions) {
    assert(
      described[option] === signedHeaders[option],
      `\`stat\` reports \`${option}\` as ${JSON.stringify(described[option])} and not as ${JSON.stringify(signedHeaders[option])} for what a signed \`PUT\` wrote`,
    );
  }

  assert(
    !("contentEncoding" in described),
    "`stat` reports a `contentEncoding` for what a signed `PUT` wrote without one",
  );
}

/**
 * What every `runWithout` half of this file asserts: spec 4.9 keeps both methods off a
 * storage that declares no `presignedUrls`, so there is no call that could fail with
 * `Unsupported` and the absence itself is what the half reads.
 */
export async function assertNeitherMethod(ctx: ConformanceContext): Promise<void> {
  for (const name of presignNames) {
    assert(
      !(name in ctx.storage),
      `The storage declares no \`presignedUrls\` and carries \`${name}\``,
    );
  }
}

/** The URL `presignGet` handed back, which a target may report as anything at runtime. */
export async function presignedGet(
  ctx: ConformanceContext,
  key: string,
  options: PresignOptions,
): Promise<string> {
  const url: unknown = await presignerOf(ctx.storage, "presignGet")(key, options);

  assert(isUrl(url), `\`presignGet\` handed back ${JSON.stringify(url)} and not a URL`);

  return url;
}

/**
 * What `presignPut` handed back, which a target may report as anything at runtime. The
 * upload sends its headers as they are, so the suite names no provider (spec 4.13).
 */
export async function presignedPut(
  ctx: ConformanceContext,
  key: string,
  options: PresignOptions,
): Promise<PresignedPut> {
  const presigned: unknown = await presignerOf(ctx.storage, "presignPut")(key, options);

  assert(
    isPresignedPut(presigned),
    `\`presignPut\` handed back ${JSON.stringify(presigned)} and not a URL with the headers that go beside the body`,
  );

  return presigned;
}

function isUrl(value: unknown): value is string {
  return typeof value === "string" && value !== "";
}

/** The shape spec 4.13 gives `PresignedPut`, its rule on `Content-Length` included. */
function isPresignedPut(value: unknown): value is PresignedPut {
  if (typeof value !== "object" || value === null) return false;

  const url: unknown = Reflect.get(value, "url");
  const headers: unknown = Reflect.get(value, "headers");

  if (!isUrl(url) || !isPlainObject(headers)) return false;

  return Object.entries(headers).every(
    ([name, field]) => typeof field === "string" && name.toLowerCase() !== "content-length",
  );
}

/**
 * An array or a `Headers` would pass the entries check above: the one lists its indices,
 * the other lists nothing at all.
 */
function isPlainObject(value: unknown): value is object {
  if (typeof value !== "object" || value === null) return false;

  const prototype: unknown = Object.getPrototypeOf(value);

  return prototype === Object.prototype || prototype === null;
}

function presignerOf(
  storage: Storage,
  name: PresignName,
): (key: string, options: PresignOptions) => Promise<unknown> {
  const held: unknown = Reflect.get(storage, name);

  assert(
    typeof held === "function",
    `The storage declares \`presignedUrls\` and carries no \`${name}\``,
  );

  // The suite sees `Storage`, where neither method is declared, so what it calls is read
  // off the storage and bound to it rather than reached through the concrete type.
  // oxlint-disable-next-line no-unsafe-type-assertion -- what the assertion above is for
  return held.bind(storage) as (key: string, options: PresignOptions) => Promise<unknown>;
}

/** The options each method takes beside the lifetime the case is about (spec 7.10). */
function lifetimeOptions(name: PresignName, expiresIn: number): PresignOptions {
  if (name === "presignGet") return { expiresIn };

  return { expiresIn, contentType: textContentType, contentLength: 0 };
}

function assertStatus(status: number, expected: number | readonly number[], what: string): void {
  const accepted = typeof expected === "number" ? [expected] : expected;

  assert(
    accepted.includes(status),
    `${what} was answered ${status} and not ${accepted.join(" or ")}`,
  );
}

/** The status, with the body read, so that the runtime is free to close the connection. */
async function statusOf(response: Response): Promise<number> {
  await response.arrayBuffer();

  return response.status;
}

async function delay(milliseconds: number): Promise<void> {
  await new Promise<void>((resolve) => void setTimeout(resolve, milliseconds));
}
