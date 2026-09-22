import { isStorageError, type ObjectStat, type PutBody, type PutOptions } from "@stowage/core";

import {
  assert,
  assertSameBytes,
  assertSameDescription,
  expectRuntimeError,
  expectStorageError,
  expectUnsupported,
} from "../assertions.ts";
import type { ConformanceCaseSource } from "../case.ts";
import type { ConformanceContext } from "../target.ts";
import {
  collect,
  kibibyte,
  mebibyte,
  multipartSize,
  patternOf,
  streamAbortedMidway,
  streamOf,
} from "./bytes.ts";
import { acceptedKeys, keyFor, prefixFor, type RefusedKey, refusedWritableKeys } from "./keys.ts";

const utf8 = new TextEncoder();

/** Spec 4.3 takes an ASCII HTTP token as a user metadata key, which this is not. */
const metadataKeyAboveAscii: Record<string, string> = { grüße: "hallo" };

/** Over the 2 KB of encoded header bytes spec 4.3 allows a whole user metadata set. */
const metadataOverTheLimit: Record<string, string> = { note: "x".repeat(2 * kibibyte) };

export const putCases: readonly ConformanceCaseSource[] = [
  {
    name: "put/bytes-round-trip",
    requires: [],
    cost: "fast",
    async run(ctx) {
      // Spec 6 has `adapter-fs` derive the content type from the key rather than store
      // the one it was given, so a case reading one back names a key it agrees with.
      const key = keyFor(ctx, "put/bytes-round-trip", "object.json");
      const bytes = patternOf(kibibyte);
      const written = await ctx.storage.put(key, bytes, { contentType: "application/json" });
      const stored = await ctx.storage.get(key);

      assertSameBytes(await stored.bytes(), bytes, "the body `get` read back");
      assertSameDescription(
        written,
        await ctx.storage.stat(key),
        ["key", "size", "contentType"],
        "`put` and a later `stat`",
      );
    },
  },
  {
    name: "put/string-round-trip",
    requires: [],
    cost: "fast",
    async run(ctx) {
      const key = keyFor(ctx, "put/string-round-trip");
      const text = "Grüße aus 日本 — ключ";
      const written = await ctx.storage.put(key, text, {
        contentType: "text/plain; charset=utf-8",
      });
      const stored = await ctx.storage.get(key);
      const read = await stored.text();

      assert(read === text, `\`text()\` read back ${JSON.stringify(read)}`);
      assert(
        written.size === utf8.encode(text).byteLength,
        `\`put\` reported ${written.size} bytes for a string of ${utf8.encode(text).byteLength} UTF-8 bytes`,
      );
    },
  },
  {
    name: "put/stream-round-trip",
    requires: [],
    cost: "fast",
    async run(ctx) {
      const key = keyFor(ctx, "put/stream-round-trip");
      const bytes = patternOf(mebibyte);

      await ctx.storage.put(key, streamOf(bytes, 64 * kibibyte));

      const stored = await ctx.storage.get(key);

      assertSameBytes(await stored.bytes(), bytes, "the body `get` read back");
    },
  },
  {
    name: "put/multipart-round-trip",
    requires: [],
    cost: "fast",
    async run(ctx) {
      const key = keyFor(ctx, "put/multipart-round-trip");
      const bytes = patternOf(multipartSize);

      await ctx.storage.put(key, streamOf(bytes, mebibyte));

      const described = await ctx.storage.stat(key);

      assert(
        described.size === multipartSize,
        `\`stat\` reports ${described.size} bytes for an upload of ${multipartSize}`,
      );

      const stored = await ctx.storage.get(key);

      assertSameBytes(await collect(stored.stream()), bytes, "the body `get` read back");
    },
  },
  {
    name: "put/empty-body",
    requires: [],
    cost: "fast",
    async run(ctx) {
      const empty = new Uint8Array(0);
      const bodies: readonly { what: string; key: string; body: PutBody }[] = [
        {
          what: "an empty `Uint8Array`",
          key: keyFor(ctx, "put/empty-body", "bytes"),
          body: empty,
        },
        {
          what: "a stream that yields nothing",
          key: keyFor(ctx, "put/empty-body", "stream"),
          body: streamOf(empty, kibibyte),
        },
      ];

      await Promise.all(
        bodies.map(async ({ what, key, body }) => {
          const written = await ctx.storage.put(key, body);

          assert(written.size === 0, `\`put\` reported ${written.size} bytes for ${what}`);

          const stored = await ctx.storage.get(key);

          assertSameBytes(await stored.bytes(), empty, `the body ${what} left behind`);
        }),
      );
    },
  },
  {
    name: "put/overwrites",
    requires: [],
    cost: "fast",
    async run(ctx) {
      const key = keyFor(ctx, "put/overwrites", "object.json");
      const second = patternOf(128);

      await ctx.storage.put(key, patternOf(64), { contentType: "text/plain" });
      await ctx.storage.put(key, second, { contentType: "application/json" });

      const stored = await ctx.storage.get(key);

      assert(
        stored.stat.contentType === "application/json",
        `The second \`put\` left the content type at ${JSON.stringify(stored.stat.contentType)}`,
      );
      assertSameBytes(await stored.bytes(), second, "the body of the overwritten object");
    },
  },
  {
    name: "put/content-type-stored",
    requires: [],
    cost: "fast",
    async run(ctx) {
      const key = keyFor(ctx, "put/content-type-stored", "note.txt");

      await ctx.storage.put(key, "a note", { contentType: "text/plain" });

      assertContentType(await ctx.storage.stat(key), "text/plain", "`stat`");
      assertContentType((await ctx.storage.get(key)).stat, "text/plain", "`get`");
    },
  },
  {
    name: "put/content-type-default",
    requires: [],
    cost: "fast",
    async run(ctx) {
      const key = keyFor(ctx, "put/content-type-default", "object-without-an-extension");

      await ctx.storage.put(key, patternOf(16));

      assertContentType(await ctx.storage.stat(key), "application/octet-stream", "`stat`");
    },
  },
  {
    name: "put/accepted-keys",
    requires: [],
    cost: "fast",
    async run(ctx) {
      const prefix = prefixFor(ctx, "put/accepted-keys");
      const accepted = acceptedKeys(prefix);

      await Promise.all(
        accepted.map(async ({ label, key }) => {
          const bytes = utf8.encode(label);

          await ctx.storage.put(key, bytes);

          const stored = await ctx.storage.get(key);

          assertSameBytes(await stored.bytes(), bytes, `the object under ${label}`);
        }),
      );

      // Spec 4.8 has a storage that does not declare `keyBytesPreserved` answer with a
      // Unicode-equivalent key, so the two sides meet in one normal form.
      const listed = new Set<string>();

      for await (const entry of ctx.storage.list({ prefix })) listed.add(entry.key.normalize());

      for (const { label, key } of accepted) {
        assert(listed.has(key.normalize()), `The listing below the prefix holds no ${label}`);
      }
    },
  },
  {
    name: "put/refused-keys",
    requires: [],
    cost: "fast",
    async run(ctx) {
      const refused = refusedWritableKeys(prefixFor(ctx, "put/refused-keys"));
      const bytes = patternOf(16);

      await Promise.all(
        refused.map(async (refusal) => {
          await expectStorageError(
            () => ctx.storage.put(refusal.key, bytes),
            {
              code: "InvalidKey",
              ...(refusal.existsAnswers === "false-or-refusal" ? {} : { attempts: 0 }),
            },
            refusal.label,
          );

          await assertNothingWasWritten(ctx, refusal);
        }),
      );
    },
  },
  {
    name: "put/unknown-option",
    requires: [],
    cost: "fast",
    async run(ctx) {
      const key = keyFor(ctx, "put/unknown-option");
      const option = "stowageTakesNoSuchOption";
      // The option is as unknown to `PutOptions` as it is to the storage, which is what
      // the case is about: the type catches one at the call site, and this the rest.
      // oxlint-disable-next-line no-unsafe-type-assertion -- the point of the case
      const options = { [option]: true } as PutOptions;
      const refusal = await expectStorageError(() => ctx.storage.put(key, patternOf(16), options), {
        code: "InvalidOption",
      });

      assert(
        refusal.message.includes(option),
        `The message ${JSON.stringify(refusal.message)} does not name the option`,
      );
      assert(
        !(await ctx.storage.exists(key)),
        "`put` wrote the object although it refused the option",
      );
    },
  },
  {
    name: "put/aborted-signal",
    requires: [],
    cost: "fast",
    async run(ctx) {
      const key = keyFor(ctx, "put/aborted-signal");

      await expectRuntimeError(
        () => ctx.storage.put(key, patternOf(16), { signal: AbortSignal.abort() }),
        "AbortError",
      );

      assert(
        !(await ctx.storage.exists(key)),
        "`put` wrote the object although the signal was aborted",
      );
    },
  },
  {
    name: "put/abort-during-upload",
    requires: [],
    cost: "fast",
    async run(ctx) {
      const key = keyFor(ctx, "put/abort-during-upload");
      const bytes = patternOf(multipartSize);
      const controller = new AbortController();

      await expectRuntimeError(
        () =>
          ctx.storage.put(key, streamAbortedMidway(bytes, mebibyte, controller), {
            signal: controller.signal,
          }),
        "AbortError",
      );
    },
  },
  {
    name: "put/stream-consumed",
    requires: [],
    cost: "fast",
    async run(ctx) {
      const key = keyFor(ctx, "put/stream-consumed");
      const body = streamOf(patternOf(64 * kibibyte), 8 * kibibyte);

      await ctx.storage.put(key, body);

      // Spec 4.2 leaves the stream at its end or canceled once `put` settled, and a read
      // answers `done` either way; a stream `put` handed back unread would not. A reader
      // `put` never released holds the lock and answers nothing at all, which is why the
      // lock is read before the body rather than as a `TypeError` out of `getReader`.
      assert(!body.locked, "The source stream is still locked to a reader `put` kept");

      const { done } = await body.getReader().read();

      assert(done, "The source stream is neither at its end nor canceled after `put`");
    },
  },
  {
    name: "put/user-metadata",
    requires: ["userMetadata"],
    cost: "fast",
    async run(ctx) {
      const key = keyFor(ctx, "put/user-metadata");
      const userMetadata = { "Written-By": "stowage", run: "conformance" };

      await ctx.storage.put(key, patternOf(16), { userMetadata });

      assertHoldsMetadata((await ctx.storage.stat(key)).userMetadata, userMetadata, "`stat`");
      assertHoldsMetadata((await ctx.storage.get(key)).stat.userMetadata, userMetadata, "`get`");
    },
    async runWithout(ctx) {
      const refused = keyFor(ctx, "put/user-metadata", "refused");
      const empty = keyFor(ctx, "put/user-metadata", "empty");

      await expectUnsupported(
        () =>
          ctx.storage.put(refused, patternOf(16), { userMetadata: { "Written-By": "stowage" } }),
        "userMetadata",
      );

      await ctx.storage.put(empty, patternOf(16), { userMetadata: {} });

      assertNoMetadata((await ctx.storage.stat(empty)).userMetadata, "`stat`");
      assertNoMetadata((await ctx.storage.get(empty)).stat.userMetadata, "`get`");
    },
  },
  {
    name: "put/user-metadata-limits",
    requires: ["userMetadata"],
    cost: "fast",
    async run(ctx) {
      const key = keyFor(ctx, "put/user-metadata-limits");
      const bytes = patternOf(16);

      await expectStorageError(
        () => ctx.storage.put(key, bytes, { userMetadata: metadataKeyAboveAscii }),
        { code: "InvalidRequest", attempts: 0 },
        "a user metadata key above ASCII",
      );
      await expectStorageError(
        () => ctx.storage.put(key, bytes, { userMetadata: metadataOverTheLimit }),
        { code: "InvalidRequest", attempts: 0 },
        "a user metadata set over 2 KB",
      );
    },
    async runWithout(ctx) {
      const key = keyFor(ctx, "put/user-metadata-limits");
      const bytes = patternOf(16);

      await expectUnsupported(
        () => ctx.storage.put(key, bytes, { userMetadata: metadataKeyAboveAscii }),
        "userMetadata",
      );
      await expectUnsupported(
        () => ctx.storage.put(key, bytes, { userMetadata: metadataOverTheLimit }),
        "userMetadata",
      );
    },
  },
];

function assertContentType(described: ObjectStat, expected: string, where: string): void {
  assert(
    described.contentType === expected,
    `${where} reports the content type ${JSON.stringify(described.contentType)} and not ${JSON.stringify(expected)}`,
  );
}

// Spec 4.3 compares user metadata keys case-insensitively, and a provider hands them
// back folded, so both sides are lowered before they are read against each other.
function assertHoldsMetadata(
  held: Readonly<Record<string, string>>,
  expected: Readonly<Record<string, string>>,
  where: string,
): void {
  const lowered = new Map(Object.entries(held).map(([name, value]) => [name.toLowerCase(), value]));

  for (const [name, value] of Object.entries(expected)) {
    const read = lowered.get(name.toLowerCase());

    assert(
      read === value,
      `${where} reports the user metadata ${JSON.stringify(name)} as ${JSON.stringify(read)} and not as ${JSON.stringify(value)}`,
    );
  }
}

function assertNoMetadata(held: Readonly<Record<string, string>>, where: string): void {
  assert(
    Object.keys(held).length === 0,
    `${where} reports the user metadata ${JSON.stringify(held)} on a storage that holds none`,
  );
}

// Spec 8.5 has `exists` answer `false` for a key `put` refused, where the key is one a
// caller may address at all.
async function assertNothingWasWritten(
  ctx: ConformanceContext,
  refused: RefusedKey,
): Promise<void> {
  if (refused.existsAnswers === "unasked") return;

  const answer = await existsOrRefusal(ctx, refused);

  assert(answer !== true, `\`exists\` answers true for ${refused.label}, which \`put\` refused`);
}

async function existsOrRefusal(
  ctx: ConformanceContext,
  refused: RefusedKey,
): Promise<boolean | "refusal"> {
  try {
    return await ctx.storage.exists(refused.key);
  } catch (thrown) {
    const refusable =
      refused.existsAnswers === "false-or-refusal" &&
      isStorageError(thrown) &&
      thrown.code === "InvalidKey";

    if (!refusable) throw thrown;

    return "refusal";
  }
}
