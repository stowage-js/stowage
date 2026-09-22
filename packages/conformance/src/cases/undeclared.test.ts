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
  const bodies = new Map<string, StoredBody>();

  const describe = (key: string): ObjectStat => ({
    key,
    size: bodies.get(key)?.bytes.byteLength ?? 0,
    lastModified: new Date(),
    contentType: bodies.get(key)?.contentType ?? "application/octet-stream",
    userMetadata:
      behavior.readsUserMetadata === true ? { "written-by": "stowage" } : (held.get(key) ?? {}),
  });

  return stubStorage({
    put: async (key, body, options) => {
      const userMetadata = options?.userMetadata ?? {};

      if (Object.keys(userMetadata).length > 0 && behavior.storesUserMetadata !== true) {
        throw unsupported("userMetadata", "put");
      }

      held.set(storedKey(key), userMetadata);
      bodies.set(storedKey(key), {
        // Every half that writes one hands over the bytes it will read back.
        bytes: body instanceof Uint8Array ? body : new Uint8Array(0),
        contentType: options?.contentType ?? "application/octet-stream",
      });

      return describe(storedKey(key));
    },
    get: async (key, options) => {
      if (options?.range !== undefined && behavior.answersRanges !== true) {
        throw unsupported("rangeReads", "get");
      }

      return storedObject(describe(storedKey(key)), bodies.get(storedKey(key))?.bytes);
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

interface StoredBody {
  readonly bytes: Uint8Array;
  readonly contentType: string;
}

const unread = (): never => {
  throw new Error("The stored object of this stub reads as bytes and as a stream alone");
};

// The half of `flow/4-streaming-download` reads the whole object out of `get`, and no
// half reads one as text or as JSON.
const storedObject = (stat: ObjectStat, bytes: Uint8Array = new Uint8Array(0)): StoredObject => ({
  stat,
  stream: () =>
    new ReadableStream({
      start(controller) {
        controller.enqueue(bytes);
        controller.close();
      },
    }),
  bytes: async () => bytes,
  text: unread,
  json: unread,
});

const runWithout = async (name: string, storage: Storage): Promise<string> => {
  const context = await startRun(stubTarget({ createStorage: () => storage }), createKeyPrefix());
  const half = selectHalf(caseNamed(name), context);

  await half.run();

  return half.mode;
};

test.each([
  "get/range",
  "get/range-unsatisfiable",
  "get/range-clipped",
  "flow/4-streaming-download",
])("`%s` holds where the storage declares no `rangeReads`", async (name) => {
  await expect(runWithout(name, undeclaring())).resolves.toBe("without");
});

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
  "flow/2-presigned-put",
])("`%s` holds where the storage declares no `presignedUrls`", async (name) => {
  await expect(runWithout(name, undeclaring())).resolves.toBe("without");
});

test("the `presign/get` half refuses a storage carrying a method it declared nothing for", async () => {
  // ADR 0011: presigning is the one capability that adds a method rather than changing a
  // behavior, so the half reads the two names off the storage and nothing else.
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
