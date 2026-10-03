import { memoryStorage } from "@stowage/adapter-memory";
import { s3Storage } from "@stowage/adapter-s3";
import { presignUpload, redirectToObject } from "@stowage/http";
import { expect, test } from "vitest";

import { lazyStorage } from "./index.ts";

// Spec 13: what this file holds is checked by the repository's type check, which compiles
// the tests; a line that stops compiling, or a `@ts-expect-error` that stops erring, fails it.

// Presigning signs locally, so no request reaches this endpoint.
const files = lazyStorage(() =>
  s3Storage({
    bucket: "files",
    region: "us-east-1",
    endpoint: "http://127.0.0.1:9",
    forcePathStyle: true,
    credentials: { accessKeyId: "unused", secretAccessKey: "unused" },
  }),
);

test("the getter keeps the concrete type, which the layer's presigning functions take", async () => {
  const redirected = await redirectToObject(files(), "a", new Request("http://localhost/"), {
    expiresIn: 60,
  });
  const presigned = await presignUpload(files(), "a", {
    expiresIn: 60,
    maxSize: 11,
    contentType: "text/plain",
    contentLength: 11,
  });

  expect(redirected.status).toBe(302);
  expect(presigned.status).toBe(200);
});

test("a storage that cannot presign is refused where the layer presigns", async () => {
  const avatars = lazyStorage(memoryStorage);

  await expect(
    // @ts-expect-error -- `MemoryStorage` has no `presignGet` (spec 5)
    redirectToObject(avatars(), "a", new Request("http://localhost/"), { expiresIn: 60 }),
  ).rejects.toThrow(TypeError);
});

test("a factory returning a `Promise` does not type-check", () => {
  // Spec 13: whatever is asynchronous belongs in the credential resolver of spec 4.12.
  // @ts-expect-error -- a `Promise` is no `Storage`
  const avatars = lazyStorage(async () => await Promise.resolve(memoryStorage()));

  expect(avatars()).toBeInstanceOf(Promise);
});
