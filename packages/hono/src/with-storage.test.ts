import { memoryStorage } from "@stowage/adapter-memory";
import { type Context, Hono } from "hono";
import { expect, test } from "vitest";

import { withStorage } from "./index.ts";

test("sets a constructed storage on `c.var` under the name it was given, as it is", async () => {
  const avatars = memoryStorage();
  const app = new Hono()
    .use(withStorage("avatars", avatars))
    .get("/", (c) => c.json({ same: c.var.avatars === avatars }));

  expect(await (await app.request("/")).json()).toEqual({ same: true });
});

test("calls a function on every request and caches nothing it returned", async () => {
  const built: unknown[] = [];
  const app = new Hono()
    .use(
      withStorage("avatars", () => {
        const storage = memoryStorage();

        built.push(storage);

        return storage;
      }),
    )
    .get("/", (c) => c.json({ index: built.indexOf(c.var.avatars) }));

  expect(await (await app.request("/")).json()).toEqual({ index: 0 });
  expect(await (await app.request("/")).json()).toEqual({ index: 1 });
});

test("waits for a storage the function resolves with", async () => {
  const avatars = memoryStorage();
  const app = new Hono()
    .use(withStorage("avatars", async () => await Promise.resolve(avatars)))
    .get("/", (c) => c.json({ same: c.var.avatars === avatars }));

  expect(await (await app.request("/")).json()).toEqual({ same: true });
});

test("hands the function the context, whose `Bindings` its annotated parameter names", async () => {
  interface Bindings {
    readonly BUCKET: string;
  }

  const buckets: string[] = [];
  const app = new Hono<{ Bindings: Bindings }>()
    .use(
      withStorage("avatars", (c: Context<{ Bindings: Bindings }>) => {
        buckets.push(c.env.BUCKET);

        return memoryStorage();
      }),
    )
    .get("/", (c) => c.body(null, 204));

  await app.request("/", {}, { BUCKET: "avatars" });

  expect(buckets).toEqual(["avatars"]);
});
