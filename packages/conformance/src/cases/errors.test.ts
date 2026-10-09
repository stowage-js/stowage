import {
  type ObjectListing,
  type ObjectStat,
  type Storage,
  StorageError,
  type StorageErrorCode,
  type StoredObject,
} from "@stowage/core";
import { expect, test } from "vitest";

import { createKeyPrefix, selectHalf, startRun } from "../run.ts";
import { caseNamed, type StubStorageFields, stubStorage, stubTarget } from "../stubs.ts";
import type { ConformanceFactoryName, ConformanceTarget } from "../target.ts";

/**
 * A storage that refuses every request the way a provider refuses a credential, which is
 * what the three cases of spec 14.3 run against. No adapter of this repository supplies a
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
    delete: async () => refuse("delete"),
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

test("`errors/bad-credentials` accepts the second attempt a refreshing adapter spends", async () => {
  await expect(
    runAgainst(
      "errors/bad-credentials",
      "createStorageWithBadCredentials",
      stubStorage(refusingFields("InvalidCredentials", 2)),
    ),
  ).resolves.toBe("declared");

  await expect(
    runAgainst(
      "errors/bad-credentials",
      "createStorageWithBadCredentials",
      stubStorage(refusingFields("InvalidCredentials", 3)),
    ),
  ).rejects.toThrow("`attempts: 3` rather than 1 or 2");
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

/** A refusal `stat` reports by the status of its `HEAD` alone, as `adapter-s3` did before ADR 0066. */
const statReadByStatus = (fields: StubStorageFields): Storage =>
  stubStorage({
    ...fields,
    stat: async () => {
      throw new StorageError({
        code: "AccessDenied",
        message: "The provider answered 403 to `HEAD`",
        operation: "stat",
        bucket: "stub",
        provider: "stub",
        retryable: false,
        attempts: 1,
      });
    },
  });

test("the `errors/bad-credentials` case refuses a `stat` that reports the refusal as `AccessDenied`", async () => {
  await expect(
    runAgainst(
      "errors/bad-credentials",
      "createStorageWithBadCredentials",
      statReadByStatus(refusingFields("InvalidCredentials", 1)),
    ),
  ).rejects.toThrow('`code: "InvalidCredentials"` for `stat`');
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

test("the `errors/expired-credentials` case refuses a `stat` that reports the refusal as `AccessDenied`", async () => {
  await expect(
    runAgainst(
      "errors/expired-credentials",
      "createStorageWithExpiredCredentials",
      statReadByStatus(refusingFields("Expired", 2)),
    ),
  ).rejects.toThrow('`code: "Expired"` for `stat`');
});

interface StaleCredential {
  /** How often the adapter asks for a fresh credential before its first answer. */
  readonly refreshes: number;
  /** Whether that answer is the operation's, or the refusal of a credential still stale. */
  readonly recovers: boolean;
}

/**
 * A bucket that `createStorage` writes to and the stale factory reads from, each of whose
 * storages meets the refusal on its first request alone, as an adapter whose resolver keeps
 * what it was last asked to refresh does.
 */
const staleTarget = ({ refreshes, recovers }: StaleCredential): ConformanceTarget => {
  const held = new Map<string, Uint8Array>();

  const storageOver = (beforeEachRequest: (operation: string) => void): Storage =>
    stubStorage({
      put: async (key, body) => {
        beforeEachRequest("put");
        if (!(body instanceof Uint8Array)) throw new Error("The case hands `put` bytes");
        held.set(key, body);

        return described(key, body.byteLength);
      },
      get: async (key) => {
        beforeEachRequest("get");

        return storedObject(described(key, held.get(key)?.byteLength ?? 0), held.get(key));
      },
      stat: async (key) => {
        beforeEachRequest("stat");

        return described(key, held.get(key)?.byteLength ?? 0);
      },
    });

  return stubTarget({
    createStorage: () => storageOver(() => undefined),
    createStorageWithStaleCredentials: (onRefresh) => {
      let stale = true;

      return storageOver((operation) => {
        if (!stale) return;

        for (let refresh = 0; refresh < refreshes; refresh += 1) onRefresh();
        if (!recovers) throw refusal("InvalidCredentials", operation, 1 + refreshes);
        stale = false;
      });
    },
  });
};

const refusal = (code: StorageErrorCode, operation: string, attempts: number): StorageError =>
  new StorageError({
    code,
    message: "The provider refused the credential",
    operation,
    bucket: "stub",
    provider: "stub",
    retryable: false,
    attempts,
  });

const described = (key: string, size: number): ObjectStat => ({
  key,
  size,
  lastModified: new Date(),
  contentType: "application/octet-stream",
  userMetadata: {},
});

const unread = (): never => {
  throw new Error("The stored object of this stub reads as bytes alone");
};

const storedObject = (stat: ObjectStat, bytes: Uint8Array = new Uint8Array(0)): StoredObject => ({
  stat,
  stream: unread,
  bytes: async () => bytes,
  text: unread,
  json: unread,
});

const runStale = async (credential: StaleCredential): Promise<string> => {
  const half = selectHalf(
    caseNamed("errors/stale-credentials"),
    await startRun(staleTarget(credential), createKeyPrefix()),
  );

  await half.run();

  return half.mode;
};

test("`errors/stale-credentials` holds against an adapter that refreshes once and recovers", async () => {
  await expect(runStale({ refreshes: 1, recovers: true })).resolves.toBe("declared");
});

// Against a server that checks no credential the operation succeeds without a refresh, and
// the case would show nothing.
test("`errors/stale-credentials` refuses a success that cost no refresh", async () => {
  await expect(runStale({ refreshes: 0, recovers: true })).rejects.toThrow(
    "`get` under a stale credential succeeded without a refresh",
  );
});

// ADR 0067: `get` on GCS sends two requests side by side, and each meets the stale credential.
test("`errors/stale-credentials` holds against an adapter whose requests each refresh", async () => {
  await expect(runStale({ refreshes: 2, recovers: true })).resolves.toBe("declared");
});

test("`errors/stale-credentials` names the refusal of an adapter that never refreshes", async () => {
  await expect(runStale({ refreshes: 0, recovers: false })).rejects.toThrow(
    "`get` under a stale credential rejected with `InvalidCredentials` and `attempts: 1` after no refresh",
  );
});

test("`errors/stale-credentials` names the refusal of the refreshed credential", async () => {
  await expect(runStale({ refreshes: 1, recovers: false })).rejects.toThrow(
    "`get` under a stale credential rejected with `InvalidCredentials` and `attempts: 2` after one refresh",
  );
});

test("`errors/missing-bucket` holds against a provider that names the bucket as missing", async () => {
  await expect(
    runAgainst(
      "errors/missing-bucket",
      "createStorageWithMissingBucket",
      stubStorage(refusingFields("NotFound", 1)),
    ),
  ).resolves.toBe("declared");
});

// ADR 0043: R2 answers a bucket its token is not scoped to, missing or not, with `403`, and
// the rule holds there as long as nothing reads like an absent object.
test("`errors/missing-bucket` holds against a provider that refuses rather than names the bucket", async () => {
  await expect(
    runAgainst(
      "errors/missing-bucket",
      "createStorageWithMissingBucket",
      stubStorage(refusingFields("AccessDenied", 1)),
    ),
  ).resolves.toBe("declared");
});

test("`errors/missing-bucket` refuses a `NotFound` that names the key", async () => {
  const namingTheKey = stubStorage({
    ...refusingFields("NotFound", 1),
    stat: async (key) => {
      throw new StorageError({
        code: "NotFound",
        message: "No object under the key",
        operation: "stat",
        key,
        bucket: "stub",
        provider: "stub",
        attempts: 1,
      });
    },
  });

  await expect(
    runAgainst("errors/missing-bucket", "createStorageWithMissingBucket", namingTheKey),
  ).rejects.toThrow("`stat` in a missing bucket is `NotFound` naming the key");
});

test("`errors/missing-bucket` refuses an `exists` that answers `false`", async () => {
  const answering = stubStorage({ ...refusingFields("NotFound", 1), exists: async () => false });

  await expect(
    runAgainst("errors/missing-bucket", "createStorageWithMissingBucket", answering),
  ).rejects.toThrow("`exists` in a missing bucket, and the call resolved");
});

test("`errors/missing-bucket` refuses a `delete` that returns a report", async () => {
  const reporting = stubStorage({
    ...refusingFields("NotFound", 1),
    delete: async (...keys) => ({ requested: keys.length, failed: [] }),
  });

  await expect(
    runAgainst("errors/missing-bucket", "createStorageWithMissingBucket", reporting),
  ).rejects.toThrow("`delete` in a missing bucket, and the call resolved");
});

test("`errors/shape` refuses an error naming another bucket than the storage", async () => {
  const misreporting = stubStorage({
    ...refusingFields("NotFound", 1),
    // The case writes one object before it provokes the failures, and the refused key is
    // the one write that has to fail: it is where this storage names the wrong bucket.
    put: async (key) => {
      if (!key.includes("..")) return described(key, 0);

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
