import { readdir, readFile } from "node:fs/promises";

import { expect, test } from "vitest";

import * as nextjs from "./index.ts";

const sources = new URL("./", import.meta.url);

const publishedSources = (await readdir(sources)).filter(
  (name) => name.endsWith(".ts") && !name.endsWith(".test.ts"),
);

// Spec 13: no `params` helper, no presign helper, no override, no fake, and none of
// `@stowage/http`, which the application imports from where it lives.
test("exports `lazyStorage` and nothing else", () => {
  expect(Object.keys(nextjs)).toEqual(["lazyStorage"]);
});

test.each(publishedSources)("%s imports no `node:` module", async (name) => {
  const text = await readFile(new URL(name, sources), "utf8");

  expect(text).not.toMatch(/(?:from\s*|import\s*\(\s*)["']node:/u);
});

// Spec 13: the peer on `next` carries the promise of Next.js 16, and nothing is imported
// through it; `server-only` is the application's, which Next.js aliases (ADR 0047).
test.each(publishedSources)("%s imports neither `next` nor `server-only`", async (name) => {
  const text = await readFile(new URL(name, sources), "utf8");

  expect(text).not.toMatch(/(?:from\s*|import\s*\(?\s*)["'](?:next|server-only)["'/]/u);
});
