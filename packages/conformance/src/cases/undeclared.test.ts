import {
  type CapabilityName,
  type ObjectStat,
  type Storage,
  StorageError,
  type StoredObject,
} from "@stowage/core";
import { expect, test } from "vitest";

import { createKeyPrefix, selectHalf, startRun } from "../run.ts";
import { caseNamed, stubStorage, stubTarget } from "../stubs.ts";

interface UndeclaredBehavior {
  /** Answers a range although it declares no `rangeReads`, which the half has to catch. */
  readonly answersRanges?: boolean;
  /** Stores user metadata although it declares none, which the half has to catch. */
  readonly storesUserMetadata?: boolean;
}

/**
 * A storage keeping the weaker promise of spec 4.9 at every point it declares nothing.
 * No adapter of this repository declares as little, so the `runWithout` halves would
 * otherwise be the one part of the suite nothing here runs.
 */
const undeclaring = (behavior: UndeclaredBehavior = {}): Storage => {
  const held = new Map<string, Readonly<Record<string, string>>>();

  const describe = (key: string): ObjectStat => ({
    key,
    size: 0,
    lastModified: new Date(),
    contentType: "application/octet-stream",
    userMetadata: held.get(key) ?? {},
  });

  return stubStorage({
    put: async (key, _body, options) => {
      const userMetadata = options?.userMetadata ?? {};

      if (Object.keys(userMetadata).length > 0 && behavior.storesUserMetadata !== true) {
        throw unsupported("userMetadata", "put");
      }

      held.set(key, userMetadata);

      return describe(key);
    },
    get: async (key, options) => {
      if (options?.range !== undefined && behavior.answersRanges !== true) {
        throw unsupported("rangeReads", "get");
      }

      return bodilessObject(describe(key));
    },
    stat: async (key) => describe(key),
  });
};

const unsupported = (capability: CapabilityName, operation: string): StorageError =>
  new StorageError({
    code: "Unsupported",
    message: `This storage does not declare \`${capability}\``,
    operation,
    bucket: "stub",
    provider: "stub",
    attempts: 0,
    capability,
  });

const unread = (): never => {
  throw new Error("The stored object of this stub has no body");
};

// No `runWithout` half reads a body: each one asserts the refusal or the description.
const bodilessObject = (stat: ObjectStat): StoredObject => ({
  stat,
  stream: unread,
  bytes: unread,
  text: unread,
  json: unread,
});

const runWithout = async (name: string, storage: Storage): Promise<string> => {
  const context = await startRun(stubTarget({ createStorage: () => storage }), createKeyPrefix());
  const half = selectHalf(caseNamed(name), context);

  await half.run();

  return half.mode;
};

test.each(["get/range", "get/range-unsatisfiable", "get/range-clipped"])(
  "`%s` holds where the storage declares no `rangeReads`",
  async (name) => {
    await expect(runWithout(name, undeclaring())).resolves.toBe("without");
  },
);

test.each(["put/user-metadata", "put/user-metadata-limits"])(
  "`%s` holds where the storage declares no `userMetadata`",
  async (name) => {
    await expect(runWithout(name, undeclaring())).resolves.toBe("without");
  },
);

test("the `get/range` half refuses a storage answering a range it declared nothing for", async () => {
  await expect(runWithout("get/range", undeclaring({ answersRanges: true }))).rejects.toThrow(
    "Expected `Unsupported` naming `rangeReads`",
  );
});

test("the `put/user-metadata` half refuses a storage holding metadata it declared none for", async () => {
  await expect(
    runWithout("put/user-metadata", undeclaring({ storesUserMetadata: true })),
  ).rejects.toThrow("Expected `Unsupported` naming `userMetadata`");
});
