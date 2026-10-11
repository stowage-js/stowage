import type { CapabilityName, PutBody } from "@stowage/core";

import { assert, assertSameBytes, expectStorageError } from "../assertions.ts";
import type { ConformanceCaseSource } from "../case.ts";
import type { ConformanceContext } from "../target.ts";
import {
  collect,
  mebibyte,
  multipartSize,
  patternOf,
  streamOf,
  streamsEndingTogether,
} from "./bytes.ts";
import { keyFor, prefixFor } from "./keys.ts";

/** What a case writes: the bytes it reads back, and the body `put` is handed for them. */
interface Written {
  readonly bytes: Uint8Array;
  readonly body: () => PutBody;
}

/** Bodies of `size` bytes, which differ from each other at every byte (`patternOf`). */
type BodyOf = (seed: number) => Written;

const smallBody: BodyOf = (seed) => {
  const bytes = patternOf(16, seed);

  return { bytes, body: () => bytes };
};

/** ADR 0076: a commit path of its own on every cloud adapter, which a precondition rides. */
const multipartBody: BodyOf = (seed) => {
  const bytes = patternOf(multipartSize, seed);

  return { bytes, body: () => streamOf(bytes, mebibyte) };
};

/**
 * Spec 4.3: each of the wrong form, refused as `InvalidOption` naming `onlyIf` once the storage
 * declares the capability the form needs, an object needing `writeIfUnchanged` whatever it holds.
 */
const malformedEtags: readonly {
  readonly what: string;
  readonly etagOf: (current: string) => unknown;
}[] = [
  { what: "an empty `etag`", etagOf: () => "" },
  { what: 'an `etag` holding `"`', etagOf: (current) => `"${current}"` },
  { what: "an `etag` starting with `W/`", etagOf: (current) => `W/${current}` },
  { what: "an `etag` that is no string", etagOf: () => 42 },
];

/** What a half without `writeIfUnchanged` names, where a storage may report no `etag` to name. */
const someEtag = "conformance-etag";

/**
 * Spec 14.5: a `PreconditionFailed` is asserted with the fields its preamble lists, and with
 * neither `status` nor `providerCode`, since Azure answers `409` where the others answer `412`
 * and `adapter-memory` carries neither (ADR 0076).
 */
async function expectPreconditionFailed(
  call: () => Promise<unknown>,
  operation: string,
  key: string,
  what: string,
): Promise<void> {
  await expectStorageError(
    call,
    { code: "PreconditionFailed", retryable: false, attempts: 1, operation, key },
    what,
  );
}

/** Spec 4.3: refused before signing, whatever the value, naming the capability the form needs. */
async function expectUnsupportedPrecondition(
  call: () => Promise<unknown>,
  capability: CapabilityName,
  what: string,
): Promise<void> {
  await expectStorageError(call, { code: "Unsupported", capability, attempts: 0 }, what);
}

async function assertHolds(
  ctx: ConformanceContext,
  key: string,
  bytes: Uint8Array,
  what: string,
): Promise<void> {
  const held = await collect((await ctx.storage.get(key)).stream());

  assertSameBytes(held, bytes, what);
}

async function assertAbsent(ctx: ConformanceContext, key: string, what: string): Promise<void> {
  assert(!(await ctx.storage.exists(key)), `${what} left an object under ${JSON.stringify(key)}`);
}

function putIfAbsentCase(name: string, bodyOf: BodyOf): ConformanceCaseSource {
  return {
    name,
    requires: ["writeIfAbsent"],
    cost: "fast",
    async run(ctx) {
      const key = keyFor(ctx, name);
      const first = bodyOf(0);
      const second = bodyOf(1);

      await ctx.storage.put(key, first.body(), { onlyIf: "absent" });
      await assertHolds(ctx, key, first.bytes, 'The free key `put` wrote under `"absent"`');

      await expectPreconditionFailed(
        () => ctx.storage.put(key, second.body(), { onlyIf: "absent" }),
        "put",
        key,
        '`put` with `onlyIf: "absent"` onto a key that holds an object',
      );
      await assertHolds(ctx, key, first.bytes, 'The key a refused `onlyIf: "absent"` met');
    },
    async runWithout(ctx) {
      const free = keyFor(ctx, name, "free");
      const held = keyFor(ctx, name, "held");
      const first = bodyOf(0);
      const second = bodyOf(1);

      await expectUnsupportedPrecondition(
        () => ctx.storage.put(free, first.body(), { onlyIf: "absent" }),
        "writeIfAbsent",
        '`put` with `onlyIf: "absent"` onto a free key',
      );
      await assertAbsent(ctx, free, 'A refused `onlyIf: "absent"`');

      await ctx.storage.put(held, first.body());
      await expectUnsupportedPrecondition(
        () => ctx.storage.put(held, second.body(), { onlyIf: "absent" }),
        "writeIfAbsent",
        '`put` with `onlyIf: "absent"` onto a key that holds an object',
      );
      await assertHolds(ctx, held, first.bytes, 'The key a refused `onlyIf: "absent"` named');
    },
  };
}

function putIfUnchangedCase(
  name: string,
  bodyOf: BodyOf,
  checksForm: boolean,
): ConformanceCaseSource {
  return {
    name,
    requires: ["writeIfUnchanged"],
    cost: "fast",
    async run(ctx) {
      const key = keyFor(ctx, name);
      const free = keyFor(ctx, name, "free");
      const [first, second, third] = [bodyOf(0), bodyOf(1), bodyOf(2)];

      await ctx.storage.put(key, first.body());

      const read = await etagOfStat(ctx, key);
      const rewritten = await ctx.storage.put(key, second.body(), { onlyIf: { etag: read } });

      assert(
        rewritten.etag !== undefined && rewritten.etag !== read,
        `\`put\` over the \`etag\` of \`stat\` reports the \`etag\` ${JSON.stringify(rewritten.etag)}, and not one other than ${JSON.stringify(read)}`,
      );
      await assertHolds(ctx, key, second.bytes, "The key `put` wrote over the `etag` of `stat`");

      await expectPreconditionFailed(
        () => ctx.storage.put(key, third.body(), { onlyIf: { etag: read } }),
        "put",
        key,
        "`put` over an `etag` a second `put` made stale",
      );
      await assertHolds(ctx, key, second.bytes, "The key a stale `etag` met");

      // ADR 0070: "unchanged" against a key that holds no object is no `NotFound`.
      await expectPreconditionFailed(
        () => ctx.storage.put(free, first.body(), { onlyIf: { etag: rewritten.etag ?? read } }),
        "put",
        free,
        "`put` with `onlyIf: { etag }` onto a key that holds no object",
      );
      await assertAbsent(ctx, free, "A refused `onlyIf: { etag }`");

      if (!checksForm) return;

      const current = rewritten.etag ?? read;

      for (const { what, etagOf } of malformedEtags) {
        // oxlint-disable-next-line no-await-in-loop -- one key, so the calls go in turn
        const refusal = await expectStorageError(
          () =>
            ctx.storage.put(key, third.body(), {
              // oxlint-disable-next-line no-unsafe-type-assertion -- the wrong form is the point
              onlyIf: { etag: etagOf(current) } as { etag: string },
            }),
          { code: "InvalidOption", attempts: 0 },
          what,
        );

        assert(
          refusal.message.includes("onlyIf"),
          `The message ${JSON.stringify(refusal.message)} does not name the option \`onlyIf\``,
        );
      }

      await assertHolds(ctx, key, second.bytes, "The key a malformed `etag` named");
    },
    async runWithout(ctx) {
      const key = keyFor(ctx, name);
      const free = keyFor(ctx, name, "free");
      const [first, second] = [bodyOf(0), bodyOf(1)];

      await ctx.storage.put(key, first.body());

      const etag = (await ctx.storage.stat(key)).etag ?? someEtag;

      await expectUnsupportedPrecondition(
        () => ctx.storage.put(key, second.body(), { onlyIf: { etag } }),
        "writeIfUnchanged",
        "`put` with `onlyIf: { etag }` onto a key that holds an object",
      );
      await assertHolds(ctx, key, first.bytes, "The key a refused `onlyIf: { etag }` named");

      await expectUnsupportedPrecondition(
        () => ctx.storage.put(free, second.body(), { onlyIf: { etag } }),
        "writeIfUnchanged",
        "`put` with `onlyIf: { etag }` onto a free key",
      );
      await assertAbsent(ctx, free, "A refused `onlyIf: { etag }`");
    },
  };
}

/**
 * Two writers racing for one free key under `"absent"`: exactly one resolves (spec 4.11, ADR
 * 0076). `bodiesOf` hands over the two bodies at once, so that a pacing can hold them together.
 */
function concurrentIfAbsentCase(
  name: string,
  bodiesOf: () => readonly [Written, Written],
): ConformanceCaseSource {
  return {
    name,
    requires: ["writeIfAbsent"],
    cost: "fast",
    async run(ctx) {
      const key = keyFor(ctx, name);
      const writers = bodiesOf();
      const outcomes = await Promise.allSettled(
        writers.map((writer) => ctx.storage.put(key, writer.body(), { onlyIf: "absent" })),
      );
      const winners = outcomes.flatMap((outcome, index) =>
        outcome.status === "fulfilled" ? [index] : [],
      );

      assert(
        winners.length === 1,
        `${winners.length} of the two writers under \`onlyIf: "absent"\` resolved, and not exactly one`,
      );

      const loser = outcomes.find((outcome) => outcome.status === "rejected");

      await expectPreconditionFailed(
        async () => {
          throw loser?.reason;
        },
        "put",
        key,
        'the writer that lost the race under `onlyIf: "absent"`',
      );

      const winner = writers[winners[0] ?? 0];

      await assertHolds(ctx, key, winner?.bytes ?? new Uint8Array(), "The key the race wrote");
    },
    async runWithout(ctx) {
      const key = keyFor(ctx, name);
      const writers = bodiesOf();

      await Promise.all(
        writers.map((writer) =>
          expectUnsupportedPrecondition(
            () => ctx.storage.put(key, writer.body(), { onlyIf: "absent" }),
            "writeIfAbsent",
            'a racing `put` with `onlyIf: "absent"`',
          ),
        ),
      );
      await assertAbsent(ctx, key, 'Two refused writers under `onlyIf: "absent"`');
    },
  };
}

/** The bodies of `put/concurrent-writers`, paced so that each sent a part before either commits. */
function pacedMultipartBodies(): readonly [Written, Written] {
  const patterns = [patternOf(multipartSize), patternOf(multipartSize, 1)] as const;
  const [one, other] = streamsEndingTogether(patterns, mebibyte);

  return [
    { bytes: patterns[0], body: () => one ?? new ReadableStream() },
    { bytes: patterns[1], body: () => other ?? new ReadableStream() },
  ];
}

export const putPreconditionCases: readonly ConformanceCaseSource[] = [
  putIfAbsentCase("put/if-absent", smallBody),
  putIfAbsentCase("put/if-absent-multipart", multipartBody),
  putIfUnchangedCase("put/if-unchanged", smallBody, true),
  putIfUnchangedCase("put/if-unchanged-multipart", multipartBody, false),
  {
    name: "put/only-if-no-kind",
    requires: [],
    cost: "fast",
    async run(ctx) {
      const key = keyFor(ctx, "put/only-if-no-kind");

      for (const [what, onlyIf] of [
        ["`onlyIf: 42`", 42],
        ["`onlyIf: null`", null],
      ] as const) {
        // oxlint-disable-next-line no-await-in-loop -- one key, so the calls go in turn
        const refusal = await expectStorageError(
          // oxlint-disable-next-line no-unsafe-type-assertion -- a value of no kind is the point
          () => ctx.storage.put(key, patternOf(16), { onlyIf: onlyIf as unknown as "absent" }),
          { code: "InvalidOption", attempts: 0 },
          what,
        );

        assert(
          refusal.message.includes("onlyIf"),
          `The message ${JSON.stringify(refusal.message)} does not name the option \`onlyIf\``,
        );
      }

      await assertAbsent(ctx, key, "A `put` refusing an `onlyIf` of no kind");
    },
  },
  concurrentIfAbsentCase("put/concurrent-if-absent", () => [smallBody(0), smallBody(1)]),
  concurrentIfAbsentCase("put/concurrent-if-absent-multipart", pacedMultipartBodies),
];

type CopyOperation = "copy" | "move";

/**
 * The objects a copy or move case writes below its prefix: each source carries bytes of its
 * own, so the destination shows which one reached it, and `held` is what the destination
 * held before the call.
 */
async function sourcesBelow(
  ctx: ConformanceContext,
  prefix: string,
  count: number,
): Promise<readonly { readonly key: string; readonly bytes: Uint8Array }[]> {
  return await Promise.all(
    Array.from({ length: count }, async (_, index) => {
      const written = smallBody(index);
      const key = `${prefix}source-${index}`;

      await ctx.storage.put(key, written.body());

      return { key, bytes: written.bytes };
    }),
  );
}

/** Spec 4.10: a `move` refused at its destination deletes nothing, and a `copy` never does. */
async function assertSourceStays(
  ctx: ConformanceContext,
  source: { readonly key: string; readonly bytes: Uint8Array },
  operation: CopyOperation,
): Promise<void> {
  await assertHolds(ctx, source.key, source.bytes, `The source of a refused \`${operation}\``);
}

function copyIfAbsentCase(operation: CopyOperation): ConformanceCaseSource {
  const name = `${operation}/if-absent`;

  return {
    name,
    requires: ["writeIfAbsent"],
    cost: "fast",
    async run(ctx) {
      const prefix = prefixFor(ctx, name);
      const to = `${prefix}destination`;
      const [taken, refused] = await sourcesBelow(ctx, prefix, 2);

      if (taken === undefined || refused === undefined) throw new Error("Two sources expected");

      await ctx.storage[operation](taken.key, to, { onlyIf: "absent" });
      await assertHolds(
        ctx,
        to,
        taken.bytes,
        `The free key \`${operation}\` wrote under \`"absent"\``,
      );

      await expectPreconditionFailed(
        () => ctx.storage[operation](refused.key, to, { onlyIf: "absent" }),
        operation,
        to,
        `\`${operation}\` with \`onlyIf: "absent"\` onto a key that holds an object`,
      );
      await assertHolds(ctx, to, taken.bytes, 'The destination a refused `onlyIf: "absent"` met');
      await assertSourceStays(ctx, refused, operation);
    },
    async runWithout(ctx) {
      const prefix = prefixFor(ctx, name);
      const free = `${prefix}free`;
      const [source, held] = await sourcesBelow(ctx, prefix, 2);

      if (source === undefined || held === undefined) throw new Error("Two sources expected");

      await expectUnsupportedPrecondition(
        () => ctx.storage[operation](source.key, free, { onlyIf: "absent" }),
        "writeIfAbsent",
        `\`${operation}\` with \`onlyIf: "absent"\` onto a free key`,
      );
      await assertAbsent(ctx, free, `A refused \`${operation}\``);

      await expectUnsupportedPrecondition(
        () => ctx.storage[operation](source.key, held.key, { onlyIf: "absent" }),
        "writeIfAbsent",
        `\`${operation}\` with \`onlyIf: "absent"\` onto a key that holds an object`,
      );
      await assertHolds(ctx, held.key, held.bytes, `The destination of a refused \`${operation}\``);
      await assertSourceStays(ctx, source, operation);
    },
  };
}

function copyIfUnchangedCase(operation: CopyOperation): ConformanceCaseSource {
  const name = `${operation}/if-unchanged`;

  return {
    name,
    requires: ["writeIfUnchanged"],
    cost: "fast",
    async run(ctx) {
      const prefix = prefixFor(ctx, name);
      const to = `${prefix}destination`;
      const free = `${prefix}free`;
      const [taken, stale, onFree] = await sourcesBelow(ctx, prefix, 3);

      if (taken === undefined || stale === undefined || onFree === undefined) {
        throw new Error("Three sources expected");
      }

      await ctx.storage.put(to, smallBody(3).body());

      const read = await etagOfStat(ctx, to);
      const written = await ctx.storage[operation](taken.key, to, { onlyIf: { etag: read } });

      assert(
        written.etag !== undefined && written.etag !== read,
        `\`${operation}\` over the \`etag\` of \`stat\` reports the \`etag\` ${JSON.stringify(written.etag)}, and not one other than ${JSON.stringify(read)}`,
      );
      await assertHolds(
        ctx,
        to,
        taken.bytes,
        `The destination \`${operation}\` wrote over its \`etag\``,
      );

      await expectPreconditionFailed(
        () => ctx.storage[operation](stale.key, to, { onlyIf: { etag: read } }),
        operation,
        to,
        `\`${operation}\` over an \`etag\` the write before made stale`,
      );
      await assertHolds(ctx, to, taken.bytes, "The destination a stale `etag` met");
      await assertSourceStays(ctx, stale, operation);

      const current = written.etag ?? read;

      await expectPreconditionFailed(
        () => ctx.storage[operation](onFree.key, free, { onlyIf: { etag: current } }),
        operation,
        free,
        `\`${operation}\` with \`onlyIf: { etag }\` onto a key that holds no object`,
      );
      await assertAbsent(ctx, free, `A refused \`${operation}\``);
      await assertSourceStays(ctx, onFree, operation);

      // ADR 0071: a missing source is `NotFound`, also beside a destination whose `etag` holds.
      await expectStorageError(
        () => ctx.storage[operation](`${prefix}absent`, to, { onlyIf: { etag: current } }),
        { code: "NotFound", operation },
        `\`${operation}\` of a missing source onto a destination whose \`etag\` holds`,
      );
      await assertHolds(
        ctx,
        to,
        taken.bytes,
        `The destination of a \`${operation}\` without a source`,
      );
    },
    async runWithout(ctx) {
      const prefix = prefixFor(ctx, name);
      const free = `${prefix}free`;
      const [source, held] = await sourcesBelow(ctx, prefix, 2);

      if (source === undefined || held === undefined) throw new Error("Two sources expected");

      const etag = (await ctx.storage.stat(held.key)).etag ?? someEtag;

      await expectUnsupportedPrecondition(
        () => ctx.storage[operation](source.key, held.key, { onlyIf: { etag } }),
        "writeIfUnchanged",
        `\`${operation}\` with \`onlyIf: { etag }\` onto a key that holds an object`,
      );
      await assertHolds(ctx, held.key, held.bytes, `The destination of a refused \`${operation}\``);

      await expectUnsupportedPrecondition(
        () => ctx.storage[operation](source.key, free, { onlyIf: { etag } }),
        "writeIfUnchanged",
        `\`${operation}\` with \`onlyIf: { etag }\` onto a free key`,
      );
      await assertAbsent(ctx, free, `A refused \`${operation}\``);
      await assertSourceStays(ctx, source, operation);
    },
  };
}

export const copyPreconditionCases: readonly ConformanceCaseSource[] = [
  copyIfAbsentCase("copy"),
  copyIfUnchangedCase("copy"),
];

export const movePreconditionCases: readonly ConformanceCaseSource[] = [
  copyIfAbsentCase("move"),
  copyIfUnchangedCase("move"),
];

/** The `etag` `stat` reports, which spec 4.4 promises where `writeIfUnchanged` is declared. */
async function etagOfStat(ctx: ConformanceContext, key: string): Promise<string> {
  const { etag } = await ctx.storage.stat(key);

  assert(etag !== undefined, `\`stat\` reports no \`etag\` for ${JSON.stringify(key)}`);

  return etag;
}
