import {
  type CapabilityName,
  type ObjectStat,
  type Storage,
  StorageError,
  type StoredObject,
} from "@stowage/core";
import { expect, test } from "vitest";

import { createKeyPrefix, selectHalf, startRun } from "../run.ts";
import { caseNamed, stubListing, stubStorage, stubTarget } from "../stubs.ts";

interface UndeclaredBehavior {
  /** Answers a range although it declares no `rangeReads`, which the half has to catch. */
  readonly answersRanges?: boolean;
  /** Stores user metadata although it declares none, which the half has to catch. */
  readonly storesUserMetadata?: boolean;
  /** Reads user metadata back although it declares none, which the half has to catch. */
  readonly readsUserMetadata?: boolean;
}

// Spec 4.9: a storage declaring no `keyBytesPreserved` hands a key back Unicode-
// equivalent to what was written, which this one does by folding it into one form.
const storedKey = (key: string): string => key.normalize();

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
    userMetadata:
      behavior.readsUserMetadata === true ? { "written-by": "stowage" } : (held.get(key) ?? {}),
  });

  return stubStorage({
    put: async (key, _body, options) => {
      const userMetadata = options?.userMetadata ?? {};

      if (Object.keys(userMetadata).length > 0 && behavior.storesUserMetadata !== true) {
        throw unsupported("userMetadata", "put");
      }

      held.set(storedKey(key), userMetadata);

      return describe(storedKey(key));
    },
    get: async (key, options) => {
      if (options?.range !== undefined && behavior.answersRanges !== true) {
        throw unsupported("rangeReads", "get");
      }

      return bodilessObject(describe(storedKey(key)));
    },
    stat: async (key) => describe(storedKey(key)),
    list: (options) =>
      stubListing(
        [...held.keys()]
          .filter((key) => key.startsWith(options?.prefix ?? ""))
          .map((key) => describe(key)),
      ),
    copy: async (from, to) => {
      held.set(storedKey(to), held.get(storedKey(from)) ?? {});

      return describe(storedKey(to));
    },
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

test.each(["put/user-metadata", "put/user-metadata-limits", "copy/user-metadata"])(
  "`%s` holds where the storage declares no `userMetadata`",
  async (name) => {
    await expect(runWithout(name, undeclaring())).resolves.toBe("without");
  },
);

test("`list/key-bytes` holds where the storage declares no `keyBytesPreserved`", async () => {
  await expect(runWithout("list/key-bytes", undeclaring())).resolves.toBe("without");
});

test.each([
  "presign/get",
  "presign/put",
  "presign/expires-in-bounds",
  "presign/put-rejects-type",
  "presign/put-rejects-length",
  "presign/expired-url",
])("`%s` holds where the storage declares no `presignedUrls`", async (name) => {
  await expect(runWithout(name, undeclaring())).resolves.toBe("without");
});

test("the `presign/get` half refuses a storage carrying a method it declared nothing for", async () => {
  // ADR 0011: presigning is the one capability that adds a method rather than changing a
  // behavior, so the half reads the two names off the storage and nothing else.
  // The extra method is what the half reads, so the storage carries one beside `Storage`.
  const signing = { ...undeclaring(), presignGet: async () => "https://example.invalid/signed" };

  await expect(runWithout("presign/get", signing)).rejects.toThrow("carries `presignGet`");
});

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

test("the `copy/user-metadata` half refuses a storage reading metadata it declared none for", async () => {
  await expect(
    runWithout("copy/user-metadata", undeclaring({ readsUserMetadata: true })),
  ).rejects.toThrow("on a storage that holds none");
});
