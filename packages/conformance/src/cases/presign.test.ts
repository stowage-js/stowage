import { type ObjectStat, type Storage, StorageError } from "@stowage/core";
import { expect, test } from "vitest";

import { createKeyPrefix, selectHalf, startRun } from "../run.ts";
import { caseNamed, stubStorage, stubTarget } from "../stubs.ts";

const utf8 = new TextEncoder();

const contentType = "text/plain";

/**
 * A storage that declares `presignedUrls` and carries the two methods on the concrete
 * type, the way `S3Storage` does. No adapter of this repository declares the capability
 * yet, so the `run` halves would otherwise be the part of the suite nothing here reads.
 */
const signing = (fields: {
  presignGet?: (key: string, options: { expiresIn: number }) => Promise<string>;
  presignPut?: (key: string, options: { expiresIn: number }) => Promise<string>;
}): Storage => {
  const held = new Map<string, string>();

  const describe = (key: string): ObjectStat => ({
    key,
    size: utf8.encode(held.get(key) ?? "").byteLength,
    lastModified: new Date(),
    contentType,
    userMetadata: {},
  });

  return {
    ...stubStorage({
      capabilities: ["presignedUrls"],
      put: async (key, body) => {
        held.set(key, typeof body === "string" ? body : "");

        return describe(key);
      },
      stat: async (key) => describe(key),
      exists: async (key) => held.has(key),
    }),
    ...fields,
  };
};

const refuseLifetime = async (): Promise<never> => {
  throw new StorageError({
    code: "InvalidOption",
    message: "`expiresIn` takes a whole number of seconds from 1 to 604800",
    operation: "presignGet",
    bucket: "stub",
    provider: "stub",
    attempts: 0,
  });
};

const run = async (name: string, storage: Storage): Promise<string> => {
  const context = await startRun(stubTarget({ createStorage: () => storage }), createKeyPrefix());
  const half = selectHalf(caseNamed(name), context);

  await half.run();

  return half.mode;
};

test("`presign/get` reads the answer of the URL a storage handed out", async () => {
  // A `data:` URL is one `fetch` answers without a provider, which is as far as a test of
  // this package goes: the signature itself belongs to `adapter-s3`.
  const storage = signing({
    presignGet: async () =>
      `data:${contentType};base64,${btoa("the body a signed `GET` hands out")}`,
  });

  await expect(run("presign/get", storage)).resolves.toBe("declared");
});

test("the `presign/get` case refuses a URL answering another body than the object holds", async () => {
  const storage = signing({
    presignGet: async () => `data:${contentType};base64,${btoa("another body")}`,
  });

  await expect(run("presign/get", storage)).rejects.toThrow(
    "the body a signed `GET` answered with",
  );
});

test("`presign/expires-in-bounds` reads both methods for the lifetimes spec 7.10 refuses", async () => {
  const storage = signing({ presignGet: refuseLifetime, presignPut: refuseLifetime });

  await expect(run("presign/expires-in-bounds", storage)).resolves.toBe("declared");
});

test("the `presign/expires-in-bounds` case refuses a storage signing a lifetime outside them", async () => {
  const storage = signing({
    presignGet: refuseLifetime,
    presignPut: async () => "https://example.invalid/signed",
  });

  await expect(run("presign/expires-in-bounds", storage)).rejects.toThrow(
    "`presignPut` with an `expiresIn` of 0, and the call resolved",
  );
});
