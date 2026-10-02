import { readdir, readFile } from "node:fs/promises";

import { expect, test } from "vitest";

import * as hono from "./index.ts";

const sources = new URL("./", import.meta.url);

const publishedSources = (await readdir(sources)).filter(
  (name) => name.endsWith(".ts") && !name.endsWith(".test.ts"),
);

// Spec 12: no route factory, no `onError` handler, no override, no fake, and none of
// `@stowage/http`, which the application imports from where it lives.
test("exports `withStorage` and nothing else", () => {
  expect(Object.keys(hono)).toEqual(["withStorage"]);
});

test.each(publishedSources)("%s imports no `node:` module", async (name) => {
  const text = await readFile(new URL(name, sources), "utf8");

  expect(text).not.toMatch(/(?:from\s*|import\s*\(\s*)["']node:/u);
});

// Spec 1, spec 12: the package treats no runtime apart, so it reads none of the globals a
// runtime is told apart by.
test.each(publishedSources)("%s detects no runtime", async (name) => {
  const text = await readFile(new URL(name, sources), "utf8");

  expect(text).not.toMatch(/\b(?:navigator|process|Deno|Bun|WebSocketPair|EdgeRuntime)\b/u);
});
