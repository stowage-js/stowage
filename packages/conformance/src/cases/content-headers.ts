import type { ContentHeaders, ObjectStat, PutOptions } from "@stowage/core";

import { assert, expectStorageError, expectUnsupported } from "../assertions.ts";
import type { ConformanceCaseSource } from "../case.ts";
import type { ConformanceContext } from "../target.ts";
import { mebibyte, multipartSize, patternOf, streamOf } from "./bytes.ts";
import { keyFor, prefixFor } from "./keys.ts";
import { textContentType } from "./objects.ts";

type ContentHeaderOption = keyof ContentHeaders;

/** ADR 0068: a parameter without a space before it, which a copy on Azure left to itself adds. */
const carriedContentType = "text/plain;charset=utf-8";

const contentHeaderOptions: readonly ContentHeaderOption[] = [
  "cacheControl",
  "contentDisposition",
  "contentLanguage",
];

/**
 * ADR 0064: a tab and a run of spaces in `contentDisposition`, which the folding of a Shared
 * Key signer turned into `403`; a `cacheControl` SeaweedFS parses; and a `contentLanguage`
 * with a space after its comma. ADR 0068: none of the three is in the form Azure rewrites a
 * value into when it copies the value itself, so a copy that leaves them to it shows.
 */
const writtenHeaders: Required<ContentHeaders> = {
  cacheControl: "max-age=60,\tpublic, immutable",
  contentDisposition: 'attachment;\tfilename="conformance  report.pdf"',
  contentLanguage: "de-AT, en",
};

/** What `put/content-headers-refused` sends, each refused as `InvalidOption` (ADR 0064). */
const malformedValues: readonly { readonly what: string; readonly value: unknown }[] = [
  { what: "a value that is no string", value: 60 },
  { what: "an empty value", value: "" },
  { what: "a value with a space at its start", value: " no-store" },
  { what: "a value with a space at its end", value: "no-store " },
  { what: "a value holding a line feed", value: "no-store\nx-injected: 1" },
  { what: "a value holding `ü`", value: "attachment; filename=grüße.txt" },
];

interface ContentHeaderPut {
  readonly what: string;
  readonly options: PutOptions;
}

/** Every malformed value as each of the three, which the form of spec 4.3 refuses alike. */
const malformedPuts: readonly (ContentHeaderPut & { readonly option: ContentHeaderOption })[] =
  contentHeaderOptions.flatMap((option) =>
    malformedValues.map(({ what, value }) => ({
      option,
      what: `${what} as \`${option}\``,
      options: { [option]: value },
    })),
  );

/** Spec 4.3: the header names and values of `Content-Type` and the content headers. */
const headerByteLimit = 2048;
const contentLanguageLimit = 100;

/** `contentDisposition` padded so that it and `Content-Type: text/plain` take `bytes`. */
const dispositionFilling = (bytes: number): string =>
  "x".repeat(bytes - "Content-Type".length - textContentType.length - "Content-Disposition".length);

/** The puts the bounds of spec 4.3 refuse, one byte or one character past each. */
const beyondTheBounds: readonly ContentHeaderPut[] = [
  {
    what: `${headerByteLimit + 1} header bytes with \`Content-Type\``,
    options: {
      contentType: textContentType,
      contentDisposition: dispositionFilling(headerByteLimit + 1),
    },
  },
  {
    what: `a \`contentLanguage\` of ${contentLanguageLimit + 1} characters`,
    options: { contentLanguage: "x".repeat(contentLanguageLimit + 1) },
  },
];

/** The puts that meet the bounds of spec 4.3 exactly, which a storage has to keep. */
const atTheBounds: readonly ContentHeaderPut[] = [
  {
    what: `exactly ${headerByteLimit} header bytes with \`Content-Type\``,
    options: {
      contentType: textContentType,
      contentDisposition: dispositionFilling(headerByteLimit),
    },
  },
  {
    what: `a \`contentLanguage\` of exactly ${contentLanguageLimit} characters`,
    options: { contentLanguage: "x".repeat(contentLanguageLimit) },
  },
];

export const putContentHeaderCases: readonly ConformanceCaseSource[] = [
  {
    name: "put/content-headers",
    requires: ["contentHeaders"],
    cost: "fast",
    async run(ctx) {
      const key = keyFor(ctx, "put/content-headers");

      const written = await ctx.storage.put(key, patternOf(16), writtenHeaders);

      assertHoldsHeaders(written, "`put`");
      assertHoldsHeaders(await ctx.storage.stat(key), "`stat`");
      assertHoldsHeaders((await ctx.storage.get(key)).stat, "`get`");

      const rewritten = await ctx.storage.put(key, patternOf(16));

      assertNoHeaders(rewritten, "`put` without them");
      assertNoHeaders(await ctx.storage.stat(key), "`stat` after a `put` without them");
    },
    async runWithout(ctx) {
      const refused = keyFor(ctx, "put/content-headers", "refused");
      const plain = keyFor(ctx, "put/content-headers", "plain");

      // ADR 0060: what a storage cannot hold it does not check, so `""` is no `InvalidOption`.
      const alone = contentHeaderOptions.flatMap((option) =>
        [writtenHeaders[option], ""].map((value) => ({
          what: `\`${option}\` as ${JSON.stringify(value)}`,
          options: { [option]: value },
        })),
      );

      await expectUnsupportedPuts(ctx, refused, alone);
      await assertNothingWritten(ctx, refused);

      const written = await ctx.storage.put(plain, patternOf(16));

      assertNoHeaders(written, "`put`");
      assertNoHeaders(await ctx.storage.stat(plain), "`stat`");
      assertNoHeaders((await ctx.storage.get(plain)).stat, "`get`");
    },
  },
  {
    name: "put/content-headers-multipart",
    requires: ["contentHeaders"],
    cost: "fast",
    async run(ctx) {
      const key = keyFor(ctx, "put/content-headers-multipart");
      const body = streamOf(patternOf(multipartSize), mebibyte);

      const written = await ctx.storage.put(key, body, writtenHeaders);

      assertHoldsHeaders(written, "`put` of a stream in parts");
      assertHoldsHeaders(await ctx.storage.stat(key), "`stat` of an object written in parts");
    },
    async runWithout(ctx) {
      const key = keyFor(ctx, "put/content-headers-multipart");
      const body = streamOf(patternOf(multipartSize), mebibyte);

      await expectUnsupported(() => ctx.storage.put(key, body, writtenHeaders), "contentHeaders");
      await assertNothingWritten(ctx, key);
    },
  },
  {
    name: "put/content-headers-refused",
    requires: ["contentHeaders"],
    cost: "fast",
    async run(ctx) {
      const refused = keyFor(ctx, "put/content-headers-refused", "refused");

      await Promise.all(
        malformedPuts.map(async ({ option, what, options }) => {
          const refusal = await expectStorageError(
            () => ctx.storage.put(refused, patternOf(16), options),
            { code: "InvalidOption", attempts: 0 },
            what,
          );

          assert(
            refusal.message.includes(option),
            `The message ${JSON.stringify(refusal.message)} does not name the option \`${option}\``,
          );
        }),
      );
      await Promise.all(
        beyondTheBounds.map(({ what, options }) =>
          expectStorageError(
            () => ctx.storage.put(refused, patternOf(16), options),
            { code: "InvalidRequest", attempts: 0 },
            what,
          ),
        ),
      );
      await assertNothingWritten(ctx, refused);

      // A bound asserted only from above would let a storage refuse more than the strictest
      // provider does (ADR 0064).
      await Promise.all(
        atTheBounds.map(async ({ what, options }, index) => {
          const key = keyFor(ctx, "put/content-headers-refused", `bound-${index}`);

          await ctx.storage.put(key, patternOf(16), options);
          assertHoldsHeaders(await ctx.storage.stat(key), `\`stat\` of ${what}`, options);
        }),
      );
    },
    async runWithout(ctx) {
      const key = keyFor(ctx, "put/content-headers-refused");

      await expectUnsupportedPuts(ctx, key, [...malformedPuts, ...beyondTheBounds, ...atTheBounds]);
      await assertNothingWritten(ctx, key);
    },
  },
];

export const copyContentHeaderCase: ConformanceCaseSource = {
  name: "copy/content-headers",
  requires: ["contentHeaders"],
  cost: "fast",
  async run(ctx) {
    await assertKeptThrough(ctx, "copy");
  },
  async runWithout(ctx) {
    await assertNoneThrough(ctx, "copy");
  },
};

export const moveContentHeaderCase: ConformanceCaseSource = {
  name: "move/content-headers",
  requires: ["contentHeaders"],
  cost: "fast",
  async run(ctx) {
    await assertKeptThrough(ctx, "move");
  },
  async runWithout(ctx) {
    await assertNoneThrough(ctx, "move");
  },
};

async function assertKeptThrough(
  ctx: ConformanceContext,
  operation: "copy" | "move",
): Promise<void> {
  const prefix = prefixFor(ctx, `${operation}/content-headers`);
  const from = `${prefix}source.txt`;
  const to = `${prefix}destination.txt`;

  await ctx.storage.put(from, "the body to carry", {
    contentType: carriedContentType,
    ...writtenHeaders,
  });

  const carried = await ctx.storage[operation](from, to);

  for (const [described, where] of [
    [carried, `\`${operation}\``],
    [await ctx.storage.stat(to), `\`stat\` after \`${operation}\``],
  ] as const) {
    assertHoldsHeaders(described, where);
    assertCarriedContentType(described, where);
  }

  if (operation === "move") await assertSourceGone(ctx, from);
}

async function assertNoneThrough(
  ctx: ConformanceContext,
  operation: "copy" | "move",
): Promise<void> {
  const prefix = prefixFor(ctx, `${operation}/content-headers`);
  const from = `${prefix}source.txt`;
  const to = `${prefix}destination.txt`;

  // Spec 4.9 has a storage declaring no `contentHeaders` hold none, so there is nothing for
  // the operation to carry and the operation itself is one like any other.
  await ctx.storage.put(from, "the body to carry", { contentType: textContentType });

  const carried = await ctx.storage[operation](from, to);

  assertNoHeaders(carried, `\`${operation}\``);
  assertNoHeaders(await ctx.storage.stat(to), `\`stat\` after \`${operation}\``);

  if (operation === "move") await assertSourceGone(ctx, from);
}

/**
 * Spec 4.4 has every `ObjectStat` stowage writes carry no `contentEncoding`: `put` never
 * reports one, and `copy` and `move` report the source's.
 */
function assertNoContentEncoding(described: ObjectStat, where: string): void {
  assert(
    !("contentEncoding" in described),
    `${where} reports a \`contentEncoding\` for an object stowage wrote without one`,
  );
}

function assertHoldsHeaders(
  described: ObjectStat,
  where: string,
  expected: ContentHeaders = writtenHeaders,
): void {
  for (const option of contentHeaderOptions) {
    assert(
      described[option] === expected[option],
      `${where} reports \`${option}\` as ${JSON.stringify(described[option])} and not as ${JSON.stringify(expected[option])}`,
    );
  }

  assertNoContentEncoding(described, where);
}

/**
 * Spec 4.11: a copy keeps the content type of its source byte for byte. Only the half with
 * `contentHeaders` asserts it, since `adapter-fs` derives the type from the key (spec 6).
 */
function assertCarriedContentType(described: ObjectStat, where: string): void {
  assert(
    described.contentType === carriedContentType,
    `${where} reports \`contentType\` as ${JSON.stringify(described.contentType)} and not as ${JSON.stringify(carriedContentType)}`,
  );
}

/** Spec 4.4: a member the object holds no value for is missing, not present as `undefined`. */
function assertNoHeaders(described: ObjectStat, where: string): void {
  for (const option of contentHeaderOptions) {
    assert(
      !(option in described),
      `${where} reports \`${option}\` as ${JSON.stringify(described[option])} for an object written without it`,
    );
  }

  assertNoContentEncoding(described, where);
}

async function expectUnsupportedPuts(
  ctx: ConformanceContext,
  key: string,
  puts: readonly ContentHeaderPut[],
): Promise<void> {
  await Promise.all(
    puts.map(({ what, options }) =>
      expectStorageError(
        () => ctx.storage.put(key, patternOf(16), options),
        { code: "Unsupported", capability: "contentHeaders", attempts: 0 },
        what,
      ),
    ),
  );
}

async function assertNothingWritten(ctx: ConformanceContext, key: string): Promise<void> {
  assert(
    !(await ctx.storage.exists(key)),
    `\`put\` wrote ${JSON.stringify(key)} although it refused the content headers`,
  );
}

async function assertSourceGone(ctx: ConformanceContext, from: string): Promise<void> {
  assert(
    !(await ctx.storage.exists(from)),
    `The source ${JSON.stringify(from)} is still there after \`move\``,
  );
}
