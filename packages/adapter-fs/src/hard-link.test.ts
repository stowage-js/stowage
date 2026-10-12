import { link, mkdtemp, readdir, rm, unlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { isStorageError, type StorageError } from "@stowage/core";
import { afterEach, expect, test, vi } from "vitest";

import { fsStorage } from "./index.ts";

// The file systems this suite runs on all hold hard links, so the answers of one that holds
// none, and the races a second process would cause, come from a stubbed syscall (spec 14.4).
vi.mock(import("node:fs/promises"), async (importOriginal) => {
  const actual = await importOriginal();

  return {
    ...actual,
    link: vi.fn<typeof actual.link>(actual.link),
    unlink: vi.fn<typeof actual.unlink>(actual.unlink),
  };
});

const roots: string[] = [];

afterEach(async () => {
  vi.mocked(link).mockClear();
  vi.mocked(unlink).mockClear();
  await Promise.all(
    roots.splice(0).map(async (root) => await rm(root, { recursive: true, force: true })),
  );
});

const temporaryRoot = async (): Promise<string> => {
  const root = await mkdtemp(join(tmpdir(), "stowage-fs-link-"));

  roots.push(root);

  return root;
};

const syscallError = (code: string, syscall: string): Error =>
  Object.assign(new Error(`${code}: it failed, ${syscall}`), { code, syscall });

const storageErrorOf = async (promise: Promise<unknown>): Promise<StorageError> => {
  try {
    await promise;
  } catch (error) {
    if (isStorageError(error)) return error;

    throw error;
  }

  throw new Error("The call resolved where it was expected to reject");
};

test.each(["EPERM", "ENOTSUP", "EOPNOTSUPP"])(
  "reads %s on the link of a conditional `put` as a file system without hard links",
  async (errno) => {
    const root = await temporaryRoot();
    const storage = fsStorage({ root });

    vi.mocked(link).mockRejectedValueOnce(syscallError(errno, "link"));

    const refused = await storageErrorOf(
      storage.put("docs/2026/report.csv", "a body", { onlyIf: "absent" }),
    );

    expect(refused).toMatchObject({
      code: "ProviderError",
      operation: "put",
      key: "docs/2026/report.csv",
      providerCode: errno,
      attempts: 1,
    });
    expect(refused.retryable).toBe(false);
    expect(refused.message).toContain("holds no hard links");
    // The temporary file goes, and with it the directories the call created for it.
    expect(await readdir(root)).toEqual([]);
  },
);

test.each(["copy", "move"] as const)(
  "reads `ENOTSUP` on the link of a conditional `%s` as a file system without hard links",
  async (operation) => {
    const root = await temporaryRoot();
    const storage = fsStorage({ root });

    await storage.put("from", "the source");
    vi.mocked(link).mockRejectedValueOnce(syscallError("ENOTSUP", "link"));

    const refused = await storageErrorOf(
      storage[operation]("from", "to/target", { onlyIf: "absent" }),
    );

    expect(refused).toMatchObject({ code: "ProviderError", operation, key: "to/target" });
    expect(refused.retryable).toBe(false);
    expect(refused.message).toContain("holds no hard links");
    expect(await (await storage.get("from")).text()).toBe("the source");
    expect(await readdir(root)).toEqual(["from"]);
  },
);

test("links nothing on a write without `onlyIf`, which keeps ending in a rename", async () => {
  const storage = fsStorage({ root: await temporaryRoot() });

  await storage.put("object", "a body");
  await storage.copy("object", "copied");
  await storage.move("copied", "moved");

  expect(link).not.toHaveBeenCalled();
});

test("reads `EEXIST` on a name that is free again as the precondition failing", async () => {
  const root = await temporaryRoot();
  const storage = fsStorage({ root });

  // Another process held the key as the link was made, and removed it before the adapter
  // looked at what held it.
  vi.mocked(link).mockRejectedValueOnce(syscallError("EEXIST", "link"));

  const refused = await storageErrorOf(storage.put("object", "a body", { onlyIf: "absent" }));

  expect(refused).toMatchObject({ code: "PreconditionFailed", key: "object", attempts: 1 });
  expect(await readdir(root)).toEqual([]);
});

test("leaves the object under both keys where a conditional `move` fails to remove the source", async () => {
  const root = await temporaryRoot();
  const storage = fsStorage({ root });

  await storage.put("from", "the source");
  vi.mocked(unlink).mockRejectedValueOnce(syscallError("EACCES", "unlink"));

  const refused = await storageErrorOf(storage.move("from", "to", { onlyIf: "absent" }));

  // Spec 4.10: `move` throws the error of the step that failed, and a failed delete leaves
  // the destination in place.
  expect(refused).toMatchObject({ code: "AccessDenied", operation: "move", key: "from" });
  expect(await (await storage.get("from")).text()).toBe("the source");
  expect(await (await storage.get("to")).text()).toBe("the source");
});
