import {
  type ObjectListing,
  type ObjectStat,
  type Storage,
  StorageError,
  type StorageErrorCode,
} from "@stowage/core";
import { expect, test } from "vitest";

import { createKeyPrefix, selectHalf, startRun } from "../run.ts";
import { caseNamed, type StubStorageFields, stubStorage, stubTarget } from "../stubs.ts";
import type { ConformanceFactoryName } from "../target.ts";

/**
 * A storage that refuses every request the way a provider refuses a credential, which is
 * what the three cases of spec 8.3 run against. No adapter of this repository supplies a
 * credential factory, so their halves would otherwise be the part of the suite nothing
 * here runs.
 */
const refusingFields = (code: StorageErrorCode, attempts: number): StubStorageFields => {
  const refuse = (operation: string): never => {
    throw new StorageError({
      code,
      message: "The provider refused the credential",
      operation,
      bucket: "stub",
      provider: "stub",
      retryable: false,
      attempts,
    });
  };

  return {
    put: async () => refuse("put"),
    get: async () => refuse("get"),
    stat: async () => refuse("stat"),
    exists: async () => refuse("exists"),
    copy: async () => refuse("copy"),
    list: (): ObjectListing => ({
      page: async () => refuse("list"),
      // oxlint-disable-next-line require-yield -- the refusal arrives before the first entry
      async *[Symbol.asyncIterator]() {
        refuse("list");
      },
    }),
  };
};

const runAgainst = async (
  name: string,
  factory: ConformanceFactoryName,
  storage: Storage,
): Promise<string> => {
  const target = stubTarget({ [factory]: () => storage });
  const half = selectHalf(caseNamed(name), await startRun(target, createKeyPrefix()));

  await half.run();

  return half.mode;
};

test("`errors/bad-credentials` holds against a provider that refuses the credential", async () => {
  await expect(
    runAgainst(
      "errors/bad-credentials",
      "createStorageWithBadCredentials",
      stubStorage(refusingFields("InvalidCredentials", 1)),
    ),
  ).resolves.toBe("declared");
});

test("the `errors/bad-credentials` case refuses an `exists` that answers rather than rejects", async () => {
  const answering = stubStorage({
    ...refusingFields("InvalidCredentials", 1),
    exists: async () => false,
  });

  await expect(
    runAgainst("errors/bad-credentials", "createStorageWithBadCredentials", answering),
  ).rejects.toThrow("and the call resolved");
});

test("`errors/denied-credentials` holds against a credential the provider refuses the write to", async () => {
  await expect(
    runAgainst(
      "errors/denied-credentials",
      "createStorageWithDeniedCredentials",
      stubStorage(refusingFields("AccessDenied", 1)),
    ),
  ).resolves.toBe("declared");
});

test("`errors/expired-credentials` reads the second attempt spec 7.3 has the refresh cost", async () => {
  await expect(
    runAgainst(
      "errors/expired-credentials",
      "createStorageWithExpiredCredentials",
      stubStorage(refusingFields("Expired", 2)),
    ),
  ).resolves.toBe("declared");

  await expect(
    runAgainst(
      "errors/expired-credentials",
      "createStorageWithExpiredCredentials",
      stubStorage(refusingFields("Expired", 1)),
    ),
  ).rejects.toThrow("`attempts: 1` rather than 2");
});

const stored = (key: string): ObjectStat => ({
  key,
  size: 0,
  lastModified: new Date(),
  contentType: "application/octet-stream",
  userMetadata: {},
});

test("`errors/shape` refuses an error naming another bucket than the storage", async () => {
  const misreporting = stubStorage({
    ...refusingFields("NotFound", 1),
    // The case writes one object before it provokes the failures, and the refused key is
    // the one write that has to fail: it is where this storage names the wrong bucket.
    put: async (key) => {
      if (!key.includes("..")) return stored(key);

      throw new StorageError({
        code: "InvalidKey",
        message: "The key holds a `..` segment",
        operation: "put",
        bucket: "another-bucket",
        provider: "stub",
        attempts: 0,
      });
    },
  });
  const context = await startRun(
    stubTarget({ createStorage: () => misreporting }),
    createKeyPrefix(),
  );

  await expect(selectHalf(caseNamed("errors/shape"), context).run()).rejects.toThrow(
    '`bucket: "another-bucket"` and not "stub"',
  );
});
