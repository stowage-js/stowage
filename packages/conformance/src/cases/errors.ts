import type { Storage, StorageError } from "@stowage/core";

import {
  assert,
  expectAnyStorageError,
  expectRuntimeError,
  expectStorageError,
} from "../assertions.ts";
import type { ConformanceCaseSource } from "../case.ts";
import type { ConformanceContext, ConformanceFactoryName } from "../target.ts";
import { patternOf } from "./bytes.ts";
import { keyFor, prefixFor } from "./keys.ts";

/**
 * The closed set of spec 4.10, which the core publishes as a type and not as a list the
 * way it publishes `capabilityNames`. A code outside it is one no caller can branch on.
 */
const storageErrorCodes: ReadonlySet<string> = new Set([
  "NotFound",
  "AccessDenied",
  "InvalidCredentials",
  "Expired",
  "InvalidRequest",
  "NetworkError",
  "ProviderError",
  "InvalidKey",
  "InvalidOption",
  "Unsupported",
]);

interface ProvokedFailure {
  readonly what: string;
  /** The operation spec 4.10 has the error name, which is the one the caller invoked. */
  readonly operation: string;
  provoke(): Promise<unknown>;
}

type MissingBucketFailure = Omit<ProvokedFailure, "operation">;

export const errorCases: readonly ConformanceCaseSource[] = [
  {
    name: "errors/shape",
    requires: [],
    cost: "fast",
    async run(ctx) {
      const prefix = prefixFor(ctx, "errors/shape");
      const key = `${prefix}object`;

      await ctx.storage.put(key, patternOf(16));

      for (const failure of provokedFailures(ctx, prefix, key)) {
        // oxlint-disable-next-line no-await-in-loop -- one storage, so the calls go in turn
        const thrown = await expectAnyStorageError(
          async () => await failure.provoke(),
          failure.what,
        );

        assertShape(thrown, ctx.storage, failure);
      }
    },
  },
  {
    name: "errors/not-a-storage-error",
    requires: [],
    cost: "fast",
    async run(ctx) {
      // Spec 4.10 leaves a caller two shapes to branch on, and the second one is every
      // failure that is no `StorageError`: the abort of a signal and a body that is no
      // JSON, both of which the runtime and not stowage reports.
      const prefix = prefixFor(ctx, "errors/not-a-storage-error");
      const key = `${prefix}object.txt`;

      await ctx.storage.put(key, "no JSON in here", { contentType: "text/plain" });

      await expectRuntimeError(
        () => ctx.storage.put(`${prefix}aborted`, patternOf(16), { signal: AbortSignal.abort() }),
        "AbortError",
      );
      await expectRuntimeError(
        async () => await (await ctx.storage.get(key)).json(),
        "SyntaxError",
      );
    },
  },
  {
    name: "errors/bad-credentials",
    requires: [],
    cost: "fast",
    factory: "createStorageWithBadCredentials",
    async run(ctx) {
      const prefix = prefixFor(ctx, "errors/bad-credentials");
      const storage = await storageFrom(ctx, "createStorageWithBadCredentials");

      const refused = await expectStorageError(() => storage.get(`${prefix}object`), {
        code: "InvalidCredentials",
        retryable: false,
      });

      // ADR 0021: an adapter that refreshes a refused access token spends a second attempt,
      // and the suite cannot see whether it refreshed. A third would be the retry budget
      // spent on a credential no retry makes valid.
      assert(
        refused.attempts === 1 || refused.attempts === 2,
        `Expected \`InvalidCredentials\` from \`get\`, and the error carries \`attempts: ${refused.attempts}\` rather than 1 or 2`,
      );
      // Spec 4.10 has `exists` answer `false` for `NotFound` alone and rethrow every
      // other failure, so a refused credential reaches the caller rather than reading as
      // an object that is not there.
      await expectAnyStorageError(
        () => storage.exists(`${prefix}object`),
        "`exists` under a credential the provider refuses",
      );
      await expectAnyStorageError(
        () => storage.list({ prefix }).page(),
        "`list` under a credential the provider refuses",
      );
    },
  },
  {
    name: "errors/denied-credentials",
    requires: [],
    cost: "fast",
    factory: "createStorageWithDeniedCredentials",
    async run(ctx) {
      const storage = await storageFrom(ctx, "createStorageWithDeniedCredentials");
      const key = keyFor(ctx, "errors/denied-credentials");

      // The credential the provider accepts and refuses the write to: spec 4.10 tells the
      // `403` that means this caller may not do this from the two that fail to authenticate.
      await expectStorageError(() => storage.put(key, patternOf(16)), {
        code: "AccessDenied",
        retryable: false,
        attempts: 1,
      });
    },
  },
  {
    name: "errors/expired-credentials",
    requires: [],
    cost: "slow",
    factory: "createStorageWithExpiredCredentials",
    async run(ctx) {
      const storage = await storageFrom(ctx, "createStorageWithExpiredCredentials");
      const key = keyFor(ctx, "errors/expired-credentials");

      // Spec 7.3 has the adapter resolve the credential again once the provider answered
      // `Expired`, so the failure the caller sees cost the two attempts.
      await expectStorageError(() => storage.get(key), { code: "Expired", attempts: 2 });
    },
  },
  {
    name: "errors/missing-bucket",
    requires: [],
    cost: "fast",
    factory: "createStorageWithMissingBucket",
    async run(ctx) {
      const storage = await storageFrom(ctx, "createStorageWithMissingBucket");
      const prefix = prefixFor(ctx, "errors/missing-bucket");
      const key = `${prefix}object`;

      for (const failure of missingBucketFailures(storage, prefix, key)) {
        // oxlint-disable-next-line no-await-in-loop -- one storage, so the calls go in turn
        const thrown = await expectAnyStorageError(
          async () => await failure.provoke(),
          failure.what,
        );

        // Spec 4.10 leaves the code to the provider, since one that cannot tell a missing
        // bucket from a refused one answers `AccessDenied` (ADR 0043). What it rules out is
        // a `NotFound` a caller reads as a missing object.
        assert(
          thrown.code !== "NotFound" || thrown.key === undefined,
          `${failure.what} is \`NotFound\` naming the key ${JSON.stringify(thrown.key)}, which reads as a missing object and not as a missing bucket`,
        );
      }
    },
  },
];

/**
 * Spec 4.10: every operation against a missing bucket rejects. `exists` and `delete` are the
 * two that would otherwise answer the way they answer for an absent object, with `false` and
 * with a report.
 */
function missingBucketFailures(
  storage: Storage,
  prefix: string,
  key: string,
): readonly MissingBucketFailure[] {
  return [
    {
      what: "`put` in a missing bucket",
      provoke: async () => await storage.put(key, patternOf(16)),
    },
    {
      what: "`get` in a missing bucket",
      provoke: async () => await storage.get(key),
    },
    {
      what: "`stat` in a missing bucket",
      provoke: async () => await storage.stat(key),
    },
    {
      what: "`exists` in a missing bucket",
      provoke: async () => await storage.exists(key),
    },
    {
      what: "`delete` in a missing bucket",
      provoke: async () => await storage.delete(key),
    },
    {
      what: "the first page of `list` in a missing bucket",
      provoke: async () => await storage.list({ prefix }).page(),
    },
  ];
}

/**
 * One failure per code the parity core reaches without a capability or a credential of
 * its own, across the operations that report them, which is what `errors/shape` reads.
 */
function provokedFailures(
  ctx: ConformanceContext,
  prefix: string,
  key: string,
): readonly ProvokedFailure[] {
  return [
    {
      what: "`get` on a missing key",
      operation: "get",
      provoke: async () => await ctx.storage.get(`${prefix}absent`),
    },
    {
      what: "`stat` on a missing key",
      operation: "stat",
      provoke: async () => await ctx.storage.stat(`${prefix}absent`),
    },
    {
      what: "`put` under a key holding a `..` segment",
      operation: "put",
      provoke: async () => await ctx.storage.put(`${prefix}../object`, patternOf(16)),
    },
    {
      what: "`list` with a `pageSize` of 0",
      operation: "list",
      provoke: async () => await ctx.storage.list({ prefix, pageSize: 0 }).page(),
    },
    {
      what: "`copy` onto itself",
      operation: "copy",
      provoke: async () => await ctx.storage.copy(key, key),
    },
  ];
}

// The fields arrive as `unknown` because a target may be written in JavaScript, where the
// declared type of a field promises nothing about what the error carries.
function assertShape(thrown: StorageError, storage: Storage, failure: ProvokedFailure): void {
  const code: string = thrown.code;

  assert(
    storageErrorCodes.has(code),
    `The error for ${failure.what} carries the code ${JSON.stringify(code)}, which is none of spec 4.10`,
  );
  assertField(thrown, "operation", failure.operation, failure);
  assertField(thrown, "bucket", storage.bucket, failure);
  assertField(thrown, "provider", storage.provider, failure);

  const retryable: unknown = thrown.retryable;
  const attempts: unknown = thrown.attempts;

  assert(
    typeof retryable === "boolean",
    `The error for ${failure.what} reports \`retryable: ${JSON.stringify(retryable)}\`, which is no boolean`,
  );
  assert(
    typeof attempts === "number" && Number.isInteger(attempts) && attempts >= 0,
    `The error for ${failure.what} reports \`attempts: ${JSON.stringify(attempts)}\`, which is no count`,
  );
}

function assertField(
  thrown: StorageError,
  field: "operation" | "bucket" | "provider",
  expected: string,
  failure: ProvokedFailure,
): void {
  const held: unknown = thrown[field];

  assert(
    held === expected,
    `The error for ${failure.what} reports \`${field}: ${JSON.stringify(held)}\` and not ${JSON.stringify(expected)}`,
  );
}

/** The storage of a factory of spec 10.3, which spec 10.2 has kept the case out of a run without. */
async function storageFrom(
  ctx: ConformanceContext,
  factory: ConformanceFactoryName,
): Promise<Storage> {
  const create = ctx.target[factory];

  assert(create !== undefined, `The target supplies no \`${factory}\``);

  return await create.call(ctx.target);
}
