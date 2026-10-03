import { readdir, readFile } from "node:fs/promises";

import { expect, test } from "vitest";

import * as nestjs from "./index.ts";

const sources = new URL("./", import.meta.url);

const publishedSources = (await readdir(sources)).filter(
  (name) => name.endsWith(".ts") && !name.endsWith(".test.ts"),
);

// Spec 11: no token, no `InjectStorage`, no fake, no parameter decorator, no Fastify content
// type parser, and none of `@stowage/http`, which the application imports from where it lives.
test("exports `StorageModule`, `webRequestOf` and `sendResponse` and nothing else", () => {
  expect(Object.keys(nestjs)).toEqual(["StorageModule", "sendResponse", "webRequestOf"]);
});

test.each(publishedSources)("%s imports no `node:` module", async (name) => {
  const text = await readFile(new URL(name, sources), "utf8");

  expect(text).not.toMatch(/(?:from\s*|import\s*\(\s*)["']node:/u);
});

// Spec 11: the platforms are told apart by shape, so neither becomes a peer.
test.each(publishedSources)("%s imports neither `express` nor `fastify`", async (name) => {
  const text = await readFile(new URL(name, sources), "utf8");

  expect(text).not.toMatch(/(?:from\s*|import\s*\(\s*)["'](?:express|fastify)["'/]/u);
});

// ADR 0047: the shared `tsconfig` with `erasableSyntaxOnly` holds here too, so NestJS's
// decorator functions are called rather than written as decorators.
test.each(publishedSources)("%s holds no decorator syntax", async (name) => {
  const text = await readFile(new URL(name, sources), "utf8");

  expect(text).not.toMatch(/^\s*@[A-Za-z]/mu);
});
