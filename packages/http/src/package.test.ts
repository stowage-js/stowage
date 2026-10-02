import { readdir, readFile } from "node:fs/promises";

import { expect, test } from "vitest";

const sources = new URL("./", import.meta.url);

const publishedSources = (await readdir(sources)).filter(
  (name) => name.endsWith(".ts") && !name.endsWith(".test.ts"),
);

// Spec 10.7: the package loads on `workerd`, where the bridge has nothing to do, so not
// even the bridge reaches a Node API.
test.each(publishedSources)("%s imports no `node:` module", async (name) => {
  const text = await readFile(new URL(name, sources), "utf8");

  expect(text).not.toMatch(/(?:from\s*|import\s*\(\s*)["']node:/u);
});
