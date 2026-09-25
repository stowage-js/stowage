import { type ObjectStat, type Storage, StorageError, type StoredObject } from "@stowage/core";
import { expect, test } from "vitest";

import { createKeyPrefix, selectHalf, startRun } from "../run.ts";
import { caseNamed, stubStorage, stubTarget } from "../stubs.ts";
import { collect, multipartSize } from "./bytes.ts";

interface Writer {
  /** Reads its body only after the other writer had time to finish, were it not held back. */
  readonly startsLate?: boolean;
  /**
   * How the write ends: `lostCommit` reads the body and rejects, as a writer on Azure whose
   * blocks the other commit discarded (ADR 0024); `refusedUnread` cancels the body unread
   * and rejects, as spec 4.2 has a `put` leave a stream it failed on.
   */
  readonly ends?: "resolves" | "lostCommit" | "refusedUnread";
}

interface ConcurrentStorage {
  readonly storage: Storage;
  /** How many bytes each writer had read at the moment one of them read its body's end. */
  readonly readAtEachEnd: readonly (readonly number[])[];
}

/**
 * A storage taking two writers to one key, which the case reads for how it paces them.
 * `assembles: "a-mix"` stores the first half of one writer's body and the second of the
 * other's, the object ADR 0024 names as what colliding block ids would commit.
 */
const concurrentStorage = (
  writers: readonly [Writer, Writer],
  assembles: "the-last-whole" | "a-mix" = "the-last-whole",
): ConcurrentStorage => {
  const read = writers.map(() => 0);
  const bodies: Uint8Array[] = [];
  const readAtEachEnd: number[][] = [];
  let held: Uint8Array = new Uint8Array(0);
  let calls = 0;

  const storage = stubStorage({
    put: async (key, body) => {
      const index = calls;
      const writer = writers[index] ?? {};

      calls += 1;
      if (!(body instanceof ReadableStream)) throw new Error("The case hands `put` a stream");

      if (writer.ends === "refusedUnread") {
        await body.cancel();
        throw lostWrite();
      }

      if (writer.startsLate === true) await new Promise((resolve) => setTimeout(resolve, 20));

      const counted = body.pipeThrough(
        new TransformStream<Uint8Array, Uint8Array>({
          transform(chunk, controller) {
            read[index] = (read[index] ?? 0) + chunk.byteLength;
            controller.enqueue(chunk);
          },
        }),
      );
      const bytes = await collect(counted);

      readAtEachEnd.push([...read]);
      bodies.push(bytes);

      if (writer.ends === "lostCommit") throw lostWrite();

      held = assembles === "a-mix" ? mixOf(bodies, bytes.byteLength) : bytes;

      return describe(key, held.byteLength);
    },
    get: async (key) => storedObject(describe(key, held.byteLength), held),
  });

  return { storage, readAtEachEnd };
};

const mixOf = (bodies: readonly Uint8Array[], size: number): Uint8Array => {
  const mix = new Uint8Array(size);
  const half = size / 2;

  mix.set((bodies[0] ?? new Uint8Array(size)).subarray(0, half));
  mix.set((bodies.at(-1) ?? new Uint8Array(size)).subarray(half), half);

  return mix;
};

const lostWrite = (): StorageError =>
  new StorageError({
    code: "ProviderError",
    message: "The specified block list is invalid",
    operation: "put",
    bucket: "stub",
    provider: "stub",
    retryable: false,
    attempts: 1,
  });

const describe = (key: string, size: number): ObjectStat => ({
  key,
  size,
  lastModified: new Date(),
  contentType: "application/octet-stream",
  userMetadata: {},
});

const unread = (): never => {
  throw new Error("The stored object of this stub reads as a stream alone");
};

const storedObject = (stat: ObjectStat, bytes: Uint8Array): StoredObject => ({
  stat,
  stream: () =>
    new ReadableStream({
      start(controller) {
        controller.enqueue(bytes);
        controller.close();
      },
    }),
  bytes: unread,
  text: unread,
  json: unread,
});

const runAgainst = async (storage: Storage): Promise<void> => {
  const context = await startRun(stubTarget({ createStorage: () => storage }), createKeyPrefix());

  await selectHalf(caseNamed("put/concurrent-writers"), context).run();
};

test("neither body ends before both were read to their last byte", async () => {
  const { storage, readAtEachEnd } = concurrentStorage([{}, { startsLate: true }]);

  await runAgainst(storage);

  expect(readAtEachEnd[0]).toEqual([multipartSize, multipartSize]);
});

test("a writer refused before it read its body does not hold the other one back", async () => {
  const { storage } = concurrentStorage([{ ends: "refusedUnread" }, {}]);

  await expect(runAgainst(storage)).resolves.toBeUndefined();
}, 1000);

test("a writer whose commit the other one discarded may reject", async () => {
  const { storage } = concurrentStorage([{}, { ends: "lostCommit" }]);

  await expect(runAgainst(storage)).resolves.toBeUndefined();
});

test("both writers rejecting fails the case", async () => {
  const { storage } = concurrentStorage([{ ends: "lostCommit" }, { ends: "lostCommit" }]);

  await expect(runAgainst(storage)).rejects.toThrow(/Both writers rejected/);
});

test("an object holding parts of both writers fails the case", async () => {
  const { storage } = concurrentStorage([{}, {}], "a-mix");

  await expect(runAgainst(storage)).rejects.toThrow(/neither writer's object whole/);
});
