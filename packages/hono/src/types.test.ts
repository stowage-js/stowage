import { memoryStorage } from "@stowage/adapter-memory";
import { s3Storage } from "@stowage/adapter-s3";
import { presignUpload, redirectToObject } from "@stowage/http";
import { Hono } from "hono";
import { expect, test } from "vitest";

import { withStorage } from "./index.ts";

// Spec 12: what this file holds is checked by the repository's type check, which compiles
// the tests; a line that stops compiling, or a `@ts-expect-error` that stops erring, fails it.

// Presigning signs locally, so no request reaches this endpoint.
const files = s3Storage({
  bucket: "files",
  region: "us-east-1",
  endpoint: "http://127.0.0.1:9",
  forcePathStyle: true,
  credentials: { accessKeyId: "unused", secretAccessKey: "unused" },
});

test("`c.var` keeps the concrete type, which the layer's presigning functions take", async () => {
  const app = new Hono()
    .use(withStorage("files", files))
    .get(
      "/redirect",
      async (c) => await redirectToObject(c.var.files, "a", c.req.raw, { expiresIn: 60 }),
    )
    .post(
      "/presign",
      async (c) =>
        await presignUpload(c.var.files, "a", {
          expiresIn: 60,
          maxSize: 11,
          contentType: "text/plain",
          contentLength: 11,
        }),
    );

  expect((await app.request("/redirect")).status).toBe(302);
  expect((await app.request("/presign", { method: "POST" })).status).toBe(200);
});

test("a storage that cannot presign is refused where the layer presigns", async () => {
  const app = new Hono().use(withStorage("avatars", memoryStorage())).get(
    "/",
    async (c) =>
      // @ts-expect-error -- `MemoryStorage` has no `presignGet` (spec 5)
      await redirectToObject(c.var.avatars, "a", c.req.raw, { expiresIn: 60 }),
  );

  expect((await app.request("/")).status).toBe(500);
});

test("the name reaches no route the middleware does not run on", async () => {
  const app = new Hono().get("/", (c) =>
    // @ts-expect-error -- `ContextVariableMap` is not augmented, so no route knows the name
    c.json({ set: c.var.avatars !== undefined }),
  );

  expect(await (await app.request("/")).json()).toEqual({ set: false });
});
