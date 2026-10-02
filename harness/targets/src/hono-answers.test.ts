import { createServer } from "node:http";

import { getRequestListener } from "@hono/node-server";
import { Hono } from "hono";
import { afterAll, expect, test } from "vitest";

import { memoryStorage } from "../../../packages/adapter-memory/src/index.ts";
import { withStorage } from "../../../packages/hono/src/index.ts";
import {
  acceptUpload,
  objectStatOf,
  serveObject,
  storageErrorOf,
} from "../../../packages/http/src/index.ts";
import { listening } from "./http.ts";

// Read before `getRequestListener` replaces it, so that the routes can tell its subclass
// apart from it.
const NativeResponse = globalThis.Response;

/** Whether `answer` was built with the subclass rather than with the native `Response`. */
function builtWith(answer: Response): { subclass: boolean } {
  return { subclass: answer.constructor !== NativeResponse && answer instanceof NativeResponse };
}

const app = new Hono()
  .use(withStorage("storage", memoryStorage()))
  .get("/missing", async (c) => {
    const answer = await serveObject(c.var.storage, "missing", c.req.raw);

    return c.json({ ...builtWith(answer), code: storageErrorOf(answer)?.code });
  })
  .put("/stored", async (c) => {
    const answer = await acceptUpload(c.var.storage, "stored", c.req.raw, { maxSize: 16 });

    return c.json({ ...builtWith(answer), key: objectStatOf(answer)?.key });
  });

// Spec 12: `@hono/node-server` replaces the global `Response` with a subclass, so a layer
// recognising its answers by `instanceof` would compare the wrong constructor.
const started = await listening(createServer(getRequestListener(app.fetch)));
const origin = started.url("serve", "").origin;

afterAll(async () => await started.close());

test("`storageErrorOf` answers the error behind an answer built with the subclass", async () => {
  const answer = await fetch(new URL("/missing", origin));

  expect(await answer.json()).toEqual({ subclass: true, code: "NotFound" });
});

test("`objectStatOf` answers the stat behind an answer built with the subclass", async () => {
  const answer = await fetch(new URL("/stored", origin), { method: "PUT", body: "stowage" });

  expect(await answer.json()).toEqual({ subclass: true, key: "stored" });
});
